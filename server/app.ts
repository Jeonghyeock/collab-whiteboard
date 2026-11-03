import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { LIMITS } from '../shared/limits.ts';
import { ClientMessageSchema } from '../shared/protocol.ts';
import { Room, type Connection } from './room.ts';
import { createStaticHandler } from './static.ts';
import { loadRoom, saveRoom } from './storage.ts';

export type ServerOptions = {
  port: number;
  host?: string;
  dataDir: string;
  staticDir?: string; // 없으면 WebSocket만 제공한다(개발 모드에서는 Vite가 화면을 맡는다).
  saveDelayMs?: number;
  saveRetryMs?: number; // 저장에 실패했을 때 다시 시도하기까지 기다리는 시간
  idleUnloadMs?: number;
  heartbeatMs?: number;
  // 연결 하나의 서버 송신 버퍼 상한(입장 때 보낸 welcome 은 다 빠질 때까지 따로 더한다). 정상 클라이언트가 잠깐 느려도 넉넉한 크기다.
  maxSendBufferBytes?: number;
};

export type RunningServer = {
  port: number;
  close(): Promise<void>;
};

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const {
    dataDir,
    saveDelayMs = 1000,
    saveRetryMs = 5000,
    idleUnloadMs = 30_000,
    heartbeatMs = 30_000,
    maxSendBufferBytes = 16 * 1024 * 1024,
  } = options;

  // ---- 방 관리: 접속자가 있을 때만 메모리에 올리고, 변경은 잠시 모았다가 파일에 저장한다 ----
  const rooms = new Map<string, Room>();
  const loading = new Map<string, Promise<Room>>();
  const unloadTimers = new Map<Room, NodeJS.Timeout>();
  const saveChains = new Map<string, Promise<void>>();
  let closing = false;

  // 방마다 '바뀐 횟수(changed)', '저장 줄에 넣은 횟수(queued)', '저장에 성공한 횟수(saved)'를 둔다.
  // changed > saved 이면 아직 파일에 없는 변경이 있다. 저장이 실패해도 이 차이는 남으므로, 방을 내릴 때와
  // 종료할 때 확정된 변경을 버리지 않는다. 실패하면 점점 길게(최대 1분) 기다리며 다시 시도한다.
  type SaveState = {
    changed: number;
    queued: number;
    saved: number;
    timer: NodeJS.Timeout | null;
    due: number;
    retryMs: number;
  };
  const saves = new Map<Room, SaveState>();
  const saveStateOf = (room: Room): SaveState => {
    let state = saves.get(room);
    if (!state) {
      state = { changed: 0, queued: 0, saved: 0, timer: null, due: 0, retryMs: saveRetryMs };
      saves.set(room, state);
    }
    return state;
  };
  const unsaved = (room: Room) => {
    const state = saves.get(room);
    return !!state && state.changed > state.saved;
  };

  function getRoom(roomId: string): Promise<Room> {
    const existing = rooms.get(roomId);
    if (existing) return Promise.resolve(existing);
    // 같은 방에 동시에 여러 명이 들어와도 파일은 한 번만 읽는다.
    let pending = loading.get(roomId);
    if (!pending) {
      pending = loadRoom(dataDir, roomId)
        .then((snapshot) => {
          const room = new Room(roomId, snapshot);
          room.onChange = () => markDirty(room);
          rooms.set(roomId, room);
          return room;
        })
        .finally(() => loading.delete(roomId));
      loading.set(roomId, pending);
    }
    return pending;
  }

  // delayMs 뒤에 저장한다. 더 이른 저장이 이미 잡혀 있으면 그대로 두고, 늦은 것(다시 시도 대기)이면 앞당긴다.
  function scheduleSave(room: Room, delayMs: number) {
    const state = saveStateOf(room);
    const due = Date.now() + delayMs;
    if (state.timer && state.due <= due) return;
    if (state.timer) clearTimeout(state.timer);
    state.due = due;
    state.timer = setTimeout(() => {
      state.timer = null;
      void flush(room);
    }, delayMs);
  }

  function markDirty(room: Room) {
    saveStateOf(room).changed += 1;
    scheduleSave(room, saveDelayMs);
  }

  // 같은 방의 저장은 순서대로 실행한다(임시 파일을 동시에 쓰지 않도록).
  function flush(room: Room): Promise<void> {
    const state = saveStateOf(room);
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    const previous = saveChains.get(room.id) ?? Promise.resolve();
    if (state.changed === state.queued) return previous; // 이미 저장했거나 저장 줄에 있다
    const version = state.changed;
    state.queued = version;
    const snapshot = room.toSnapshot();
    const next = previous
      .then(() => saveRoom(dataDir, room.id, snapshot))
      .then(() => {
        state.saved = Math.max(state.saved, version);
        state.retryMs = saveRetryMs;
      })
      .catch((error: unknown) => {
        console.error(`[save] room ${room.id} failed`, error);
        // 뒤이어 더 새 저장이 줄에 있지 않으면, 이 변경을 다시 저장할 대상으로 되돌린다.
        if (state.queued === version) state.queued = state.saved;
        if (!closing && state.changed > state.saved) {
          scheduleSave(room, state.retryMs);
          state.retryMs = Math.min(state.retryMs * 2, 60_000);
        }
      });
    saveChains.set(room.id, next);
    return next;
  }

  // flush 하고, 기다리는 동안 이어 붙은 저장까지 끝날 때까지 기다린다.
  async function flushAndSettle(room: Room): Promise<void> {
    let chain = flush(room);
    for (;;) {
      await chain;
      const latest = saveChains.get(room.id);
      if (!latest || latest === chain) return;
      chain = latest;
    }
  }

  function scheduleUnload(room: Room) {
    if (closing || room.memberCount > 0 || unloadTimers.has(room)) return;
    unloadTimers.set(
      room,
      setTimeout(async () => {
        unloadTimers.delete(room);
        await flushAndSettle(room);
        // 저장하는 동안 누가 다시 들어왔으면 내리지 않는다.
        if (room.memberCount > 0) return;
        // 저장이 실패해 다시 시도를 기다리는 중이면 내리지 않고, 나중에 다시 내린다.
        if (unsaved(room)) {
          scheduleUnload(room);
          return;
        }
        rooms.delete(room.id);
        saveChains.delete(room.id);
        saves.delete(room);
      }, idleUnloadMs),
    );
  }

  function cancelUnload(room: Room) {
    clearTimeout(unloadTimers.get(room));
    unloadTimers.delete(room);
  }

  // ---- HTTP + WebSocket ----
  const serveStatic = options.staticDir ? createStaticHandler(options.staticDir) : null;
  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
      return;
    }
    if (serveStatic) void serveStatic(req, res);
    else res.writeHead(404).end();
  });

  // autoPong: false — 클라이언트가 보낸 ping 프레임에 ws 가 자동으로 답하는 pong 은 아래 송신 버퍼 상한을 거치지 않아,
  // 읽지 않는 연결이 ping 만 보내면 버퍼가 끝없이 커졌다. 브라우저는 ping 프레임을 보내지 않으므로 꺼도 된다.
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxMessageBytes, autoPong: false });
  server.on('upgrade', (req, socket, head) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      // 'http://[/ws'처럼 해석할 수 없는 주소. 여기서 던지면 서버 프로세스 전체가 죽는다.
      socket.destroy();
      return;
    }
    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  // ---- 연결 상태: 생존 판정과 송신 버퍼 상한 ----
  // 응답 없는 연결(와이파이 끊김 등)은 TCP가 한참 뒤에야 알아챈다. 주기적으로 ping을 보내 정리한다.
  // - 살아 있다는 판정은 이번에 보낸 ping 의 payload(무작위)를 그대로 돌려준 pong 으로만 한다(브라우저는 자동으로 답한다).
  //   아무 메시지나, 요청하지 않은 pong 까지 살아 있다고 보면 소켓을 읽지 않는 연결이 하트비트를 피했다.
  // - pong 이 늦어도 송신 버퍼가 줄고 있으면(느리지만 받는 중) 끊지 않는다. ping 이 쌓인 버퍼 뒤에 서기 때문이다.
  // - 읽지 않는(또는 아주 느린) 연결은 서버 송신 버퍼가 끝없이 커져 결국 프로세스 메모리가 넘친다.
  //   버퍼가 welcome 여유분 + maxSendBufferBytes 를 넘으면 끊는다. 클라이언트는 다시 접속해 따라잡는다.
  type ConnState = { nonce: Buffer | null; ponged: boolean; lastBuffered: number; welcomeBytes: number };
  const states = new WeakMap<WebSocket, ConnState>();
  const overLimit = (ws: WebSocket, state: ConnState) => {
    // 입장 때 보낸 welcome(스냅샷 등)은 빠져나가는 만큼 여유분을 줄인다
    state.welcomeBytes = Math.min(state.welcomeBytes, ws.bufferedAmount);
    return ws.bufferedAmount > state.welcomeBytes + maxSendBufferBytes;
  };
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const state = states.get(ws);
      if (!state) continue;
      const draining = ws.bufferedAmount < state.lastBuffered;
      if (overLimit(ws, state) || (!state.ponged && !draining)) {
        ws.terminate();
        continue;
      }
      state.ponged = false;
      state.lastBuffered = ws.bufferedAmount;
      state.nonce = randomBytes(8);
      ws.ping(state.nonce);
    }
  }, heartbeatMs);

  wss.on('connection', (ws) => {
    // 크기 제한 초과, 잘못된 프레임 등 프로토콜 위반이 오면 ws가 'error'를 내고 소켓은 스스로 닫는다.
    // 리스너가 없으면 처리되지 않은 에러가 되어 서버 프로세스 전체가 죽으므로 받아 두기만 한다.
    ws.on('error', () => {});
    const state: ConnState = { nonce: null, ponged: true, lastBuffered: 0, welcomeBytes: 0 };
    states.set(ws, state);
    ws.on('pong', (data) => {
      if (state.nonce && data.equals(state.nonce)) state.ponged = true;
    });

    let room: Room | null = null;
    let joining = false;
    const conn: Connection = {
      send(message) {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (overLimit(ws, state)) {
          ws.terminate();
          return;
        }
        const json = JSON.stringify(message);
        if (message.type === 'welcome') state.welcomeBytes = ws.bufferedAmount + Buffer.byteLength(json);
        ws.send(json);
      },
      close(code, reason) {
        // close 프레임은 쌓인 버퍼 뒤에 서므로, 상한을 넘은 연결은 closeTimeout(30초) 동안 버퍼를 쥐고 남는다. 바로 끊는다.
        if (overLimit(ws, state)) ws.terminate();
        else ws.close(code, reason);
      },
    };
    const helloTimeout = setTimeout(() => {
      if (!room) ws.close(1008, 'hello timeout');
    }, 10_000);

    const handleMessage = async (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        ws.close(1003, 'binary messages are not supported');
        return;
      }
      let json: unknown;
      try {
        json = JSON.parse(String(data));
      } catch {
        ws.close(1007, 'invalid json');
        return;
      }
      const parsed = ClientMessageSchema.safeParse(json);
      if (!parsed.success) {
        ws.close(1008, 'invalid message');
        return;
      }
      const message = parsed.data;

      if (message.type === 'hello') {
        if (room || joining) return;
        joining = true;
        let target: Room;
        try {
          target = await getRoom(message.roomId);
        } catch (error) {
          // 저장 파일이 깨졌거나 읽을 수 없는 경우. 서버 전체가 죽지 않도록 이 연결만 닫는다.
          console.error(`[load] room ${message.roomId} failed`, error);
          ws.close(1011, 'failed to load room');
          return;
        }
        if (ws.readyState !== WebSocket.OPEN) {
          scheduleUnload(target);
          return;
        }
        clearTimeout(helloTimeout);
        cancelUnload(target);
        target.join(conn, message);
        room = target;
        return;
      }
      // hello가 처리되기 전에 온 메시지는 버린다. 클라이언트는 welcome을 받은 뒤에만 변경을 보낸다.
      room?.handle(conn, message);
    };
    // 메시지 처리 중 예상하지 못한 예외(검증 라이브러리의 버그 등)가 나도 그 연결만 닫는다.
    // async 리스너의 예외는 처리되지 않은 rejection이 되어 서버 프로세스 전체가 죽는다(zod 4.6.5 RangeError로 재현).
    ws.on('message', (data, isBinary) => {
      handleMessage(data, isBinary).catch((error: unknown) => {
        console.error('[ws] message handling failed', error);
        ws.close(1011, 'internal error');
      });
    });

    ws.on('close', () => {
      clearTimeout(helloTimeout);
      if (!room) return;
      room.leave(conn);
      scheduleUnload(room);
    });
  });

  await new Promise<void>((resolve) => server.listen(options.port, options.host, resolve));

  return {
    port: (server.address() as AddressInfo).port,
    async close() {
      closing = true;
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.close(1001, 'server shutting down');
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      for (const timer of unloadTimers.values()) clearTimeout(timer);
      // 종료 중에 저장이 실패하면 잠깐씩 기다리며 두 번 더 시도한다. 그래도 남으면 실패로 알린다(main 은 1 로 끝낸다).
      for (let attempt = 0; ; attempt++) {
        await Promise.all([...rooms.values()].map(flushAndSettle));
        const left = [...rooms.values()].filter(unsaved);
        if (left.length === 0) return;
        if (attempt === 2) throw new Error(`[save] 저장하지 못한 방: ${left.map((room) => room.id).join(', ')}`);
        await new Promise((resolve) => setTimeout(resolve, Math.min(saveRetryMs, 1000)));
      }
    },
  };
}
