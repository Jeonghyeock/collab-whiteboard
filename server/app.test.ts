import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket as WsClient } from 'ws';
import { startServer, type RunningServer } from './app.ts';

let server: RunningServer;
let dataDir: string;
let staticDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'whiteboard-app-'));
  staticDir = path.join(dataDir, 'public');
  await mkdir(staticDir);
  await writeFile(path.join(staticDir, 'index.html'), '<!doctype html><title>app</title>');
  server = await startServer({ port: 0, dataDir: path.join(dataDir, 'rooms'), staticDir });
});

afterEach(async () => {
  await server.close();
  await rm(dataDir, { recursive: true, force: true });
});

// 서버가 소켓을 닫을 때의 종료 코드를 기다린다.
function closeCodeAfter(messages: unknown[]): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${server.port}/ws`);
    ws.onopen = () => {
      for (const message of messages) ws.send(typeof message === 'string' ? message : JSON.stringify(message));
    };
    ws.onclose = (event) => resolve(event.code);
  });
}

function rawGet(requestPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: 'localhost', port: server.port, path: requestPath }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      })
      .on('error', reject);
  });
}

// 브라우저나 http 모듈로는 보낼 수 없는 요청 줄을 그대로 보내고, 서버가 연결을 닫을 때까지 기다린다.
function rawUpgrade(target: string): Promise<void> {
  return new Promise((resolve) => {
    const socket = net.connect(server.port, 'localhost', () => {
      socket.write(
        `GET ${target} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
      );
    });
    socket.on('error', () => {}); // 서버가 끊으면 ECONNRESET이 올 수 있다.
    socket.on('close', () => resolve());
  });
}

const hello = (roomId: string) => ({
  type: 'hello',
  roomId,
  clientSecret: 'clientSecretAAAAAAAA',
  lastSeq: null,
  user: { name: 'tester', color: '#123456' },
});

describe('server', () => {
  it('스키마에 맞지 않는 메시지를 보내면 연결을 끊는다', async () => {
    expect(await closeCodeAfter(['not json'])).toBe(1007);
    expect(await closeCodeAfter([{ type: 'hello', roomId: '../../etc' }])).toBe(1008);
  });

  it('저장 파일이 깨진 방에 들어오면 그 연결만 닫고 서버는 계속 동작한다', async () => {
    await mkdir(path.join(dataDir, 'rooms'), { recursive: true });
    await writeFile(path.join(dataDir, 'rooms', 'brokenRoom.json'), '{ not valid');
    expect(await closeCodeAfter([hello('brokenRoom')])).toBe(1011);
    expect(await rawGet('/healthz')).toBe(200);
  });

  it('메시지 크기 제한을 넘으면 그 연결만 닫고(1009) 서버는 계속 동작한다', async () => {
    expect(await closeCodeAfter(['x'.repeat(2 * 1024 * 1024)])).toBe(1009);
    expect(await rawGet('/healthz')).toBe(200);
  });

  it('검증이 무거운 메시지 하나로 서버가 죽지 않고, 그 연결만 닫힌다(먼저 들어온 사람은 그대로)', async () => {
    // zod 4.6.5 는 .max() 를 넘는 배열도 원소마다 이슈를 모으다 RangeError 를 던졌고, async 리스너라 처리되지 않은
    // rejection 이 되어 서버 프로세스 전체가 죽었다(인증·hello 없이 메시지 하나로 재현).
    const member = new WebSocket(`ws://localhost:${server.port}/ws`);
    await new Promise<void>((resolve) => {
      member.onopen = () => member.send(JSON.stringify(hello('crashRoom1')));
      member.onmessage = () => resolve(); // welcome
    });

    const pen = {
      id: 'aaaaaaaa',
      type: 'pen',
      x: 0,
      y: 0,
      z: 0,
      stroke: '#000000',
      strokeWidth: 2,
      points: new Array(300_000).fill(''), // 약 900KB — maxPayload(1MB) 안
    };
    const attack = { type: 'mutate', clientSeq: 1, ops: [{ type: 'add', shape: pen }] };
    expect(await closeCodeAfter([attack])).toBe(1008);

    expect(await rawGet('/healthz')).toBe(200);
    expect(member.readyState).toBe(WebSocket.OPEN);
    member.close();
  });

  it('해석할 수 없는 주소로 업그레이드를 요청하면 그 연결만 끊고 서버는 계속 동작한다', async () => {
    await rawUpgrade('http://[/ws');
    expect(await rawGet('/healthz')).toBe(200);
  });

  it('정적 파일 경로로 상위 폴더에 접근할 수 없다', async () => {
    expect(await rawGet('/..%2f..%2fpackage.json')).toBe(403);
  });

  it('확장자 없는 경로는 index.html로 보낸다 (SPA)', async () => {
    expect(await rawGet('/r/someBoard1')).toBe(200);
    expect(await rawGet('/missing.js')).toBe(404);
  });
});

describe('저장', () => {
  // 임시 파일 자리에 폴더를 만들어 두면 저장(writeFile)이 EISDIR 로 실패한다
  const blockSave = (roomsDir: string, roomId: string) => mkdir(path.join(roomsDir, `${roomId}.json.tmp`), { recursive: true });
  const unblockSave = (roomsDir: string, roomId: string) => rm(path.join(roomsDir, `${roomId}.json.tmp`), { recursive: true });
  const savedShapeIds = async (roomsDir: string, roomId: string) => {
    try {
      return Object.keys(JSON.parse(await readFile(path.join(roomsDir, `${roomId}.json`), 'utf8')).shapes);
    } catch {
      return null;
    }
  };

  // hello 를 보내 welcome 을 받은 뒤 도형 하나를 추가하고 commit 을 기다린다
  async function addShape(port: number, roomId: string) {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    const received: string[] = [];
    ws.onmessage = (event) => received.push(JSON.parse(String(event.data)).type);
    ws.onopen = () => ws.send(JSON.stringify(hello(roomId)));
    await vi.waitFor(() => expect(received).toContain('welcome')); // hello 처리 전에 온 변경은 서버가 버린다
    const shape = { id: 'shape0001', type: 'rect', x: 0, y: 0, z: 0, stroke: '#000000', strokeWidth: 2, w: 10, h: 10, fill: null };
    ws.send(JSON.stringify({ type: 'mutate', clientSeq: 1, ops: [{ type: 'add', shape }] }));
    await vi.waitFor(() => expect(received).toContain('commit'));
    return ws;
  }

  it('저장이 실패해도 다시 시도해, 방을 비우고 내리기 전에 확정된 변경을 파일에 남긴다', async () => {
    // 고치기 전에는 저장 실패 뒤 표시가 사라져, 새 변경이 없으면 방을 내릴 때도 다시 저장하지 않았다
    const roomsDir = path.join(dataDir, 'retry-rooms');
    const s = await startServer({ port: 0, dataDir: roomsDir, saveDelayMs: 10, saveRetryMs: 50, idleUnloadMs: 30 });
    try {
      await blockSave(roomsDir, 'retryRoom1');
      const ws = await addShape(s.port, 'retryRoom1');
      ws.close(); // 아무도 없으니 곧 방을 내리려 한다
      await new Promise((resolve) => setTimeout(resolve, 150)); // 저장과 내리기 직전 저장이 실패할 시간
      expect(await savedShapeIds(roomsDir, 'retryRoom1')).toBeNull();
      await unblockSave(roomsDir, 'retryRoom1');
      await vi.waitFor(async () => expect(await savedShapeIds(roomsDir, 'retryRoom1')).toEqual(['shape0001']), {
        timeout: 5000,
      });
    } finally {
      await s.close();
    }
  });

  it('접속자가 남아 있는 방도 저장 실패 뒤 다시 시도 타이머로 저장한다', async () => {
    const roomsDir = path.join(dataDir, 'retry-rooms2');
    const s = await startServer({ port: 0, dataDir: roomsDir, saveDelayMs: 10, saveRetryMs: 50 });
    try {
      await blockSave(roomsDir, 'retryRoom2');
      const ws = await addShape(s.port, 'retryRoom2'); // 연결을 유지한다 → 방을 내리지 않는다
      await new Promise((resolve) => setTimeout(resolve, 100));
      await unblockSave(roomsDir, 'retryRoom2');
      await vi.waitFor(async () => expect(await savedShapeIds(roomsDir, 'retryRoom2')).toEqual(['shape0001']), {
        timeout: 5000,
      });
      ws.close();
    } finally {
      await s.close();
    }
  });

  it('종료할 때까지 끝내 저장하지 못하면 close 가 실패를 알린다', async () => {
    // 고치기 전에는 종료 중 저장 실패를 로그만 남기고 정상 종료(exit 0)했다
    const roomsDir = path.join(dataDir, 'retry-rooms3');
    const s = await startServer({ port: 0, dataDir: roomsDir, saveDelayMs: 1000, saveRetryMs: 20 });
    await blockSave(roomsDir, 'retryRoom3');
    const ws = await addShape(s.port, 'retryRoom3');
    await expect(s.close()).rejects.toThrow(/retryRoom3/);
    ws.close();
  });
});

describe('느리거나 응답하지 않는 연결', () => {
  // 소켓을 읽지 않거나 pong 을 보내지 않는 클라이언트(ws 라이브러리로 흉내 낸다). close 를 처음부터 기록하고,
  // hello 를 보낸 뒤 welcome 을 기다린다.
  async function join(port: number, roomId: string, secret: string, options: { autoPong?: boolean } = {}) {
    const ws = new WsClient(`ws://localhost:${port}/ws`, options);
    const messages: { type: string }[] = [];
    let closed = false;
    ws.on('close', () => (closed = true));
    ws.on('message', (data) => messages.push(JSON.parse(String(data))));
    await new Promise<void>((resolve) => ws.once('open', () => resolve()));
    ws.send(JSON.stringify({ ...hello(roomId), clientSecret: secret }));
    await vi.waitFor(() => expect(messages.some((m) => m.type === 'welcome')).toBe(true));
    return { ws, messages, closed: () => closed };
  }

  async function withServer(options: { heartbeatMs?: number; maxSendBufferBytes?: number }, run: (port: number) => Promise<void>) {
    const s = await startServer({ port: 0, dataDir: path.join(dataDir, 'slow-rooms'), ...options });
    try {
      await run(s.port);
    } finally {
      await s.close();
    }
  }

  it('pong 없이 앱 ping 만 보내는 연결은 하트비트가 끊는다', async () => {
    // 고치기 전에는 아무 메시지나 받아도 살아 있다고 봐서, 앱 ping 만으로 하트비트를 피했다
    await withServer({ heartbeatMs: 50 }, async (port) => {
      const client = await join(port, 'heartbeat1', 'secretHeartbeat0001', { autoPong: false });
      const pinger = setInterval(() => {
        if (client.ws.readyState === WsClient.OPEN) client.ws.send(JSON.stringify({ type: 'ping' }));
      }, 20);
      await vi.waitFor(() => expect(client.closed()).toBe(true), { timeout: 2000 }).finally(() => clearInterval(pinger));
    });
  });

  it('요청하지 않은 pong 만 보내는 연결도 하트비트가 끊는다', async () => {
    // 서버가 보낸 ping 의 payload 를 돌려준 pong 만 살아 있다는 표시로 본다
    await withServer({ heartbeatMs: 50 }, async (port) => {
      const client = await join(port, 'heartbeat2', 'secretHeartbeat0002', { autoPong: false });
      const ponger = setInterval(() => {
        if (client.ws.readyState === WsClient.OPEN) client.ws.pong();
      }, 20);
      await vi.waitFor(() => expect(client.closed()).toBe(true), { timeout: 2000 }).finally(() => clearInterval(ponger));
    });
  });

  it('pong 으로 답하는 연결은 끊지 않는다', async () => {
    await withServer({ heartbeatMs: 50 }, async (port) => {
      const client = await join(port, 'heartbeat3', 'secretHeartbeat0003');
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(client.closed()).toBe(false);
      client.ws.close();
    });
  });

  it('클라이언트가 보낸 ping 프레임에 자동으로 pong 을 쌓지 않는다', async () => {
    // 자동 pong 은 송신 버퍼 상한을 거치지 않아, 읽지 않는 연결이 ping 만 보내도 버퍼가 끝없이 커졌다
    const client = await join(server.port, 'pingRoom01', 'secretPinger000001');
    let pongs = 0;
    client.ws.on('pong', () => (pongs += 1));
    for (let i = 0; i < 5; i++) client.ws.ping();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(pongs).toBe(0);
    client.ws.close();
  });

  it('소켓을 읽지 않는 연결은 송신 버퍼가 상한을 넘으면 끊고, 다른 사람에게 나갔다고 알린다', async () => {
    // 고치기 전에는 send 가 bufferedAmount 를 보지 않아, 읽지 않는 연결마다 서버 메모리가 끝없이 쌓였다.
    // OS 소켓 버퍼가 먼저 흡수하는 양이 환경마다 달라, 상한을 1MB 로 낮춰 어디서나 넘게 한다.
    await withServer({ maxSendBufferBytes: 1024 * 1024 }, async (port) => {
      const reader = await join(port, 'slowRoom01', 'secretSlowReader001');
      reader.ws.pause(); // 이제부터 읽지 않는다
      const flooder = await join(port, 'slowRoom01', 'secretFlooder00001');
      const points = new Array(8000).fill(999999); // 펜 하나 약 56KB
      const pen = { id: 'penshape1', type: 'pen', x: 0, y: 0, z: 0, stroke: '#000000', strokeWidth: 2, points };
      flooder.ws.send(JSON.stringify({ type: 'mutate', clientSeq: 1, ops: [{ type: 'add', shape: pen }] }));
      // 커밋 하나 약 0.9MB 를 최대 60번(약 54MB) 보낸다.
      // flooder 도 커밋을 받는다. 확인(commit)을 받은 뒤에 다음 변경을 보내야 flooder 쪽 버퍼에 커밋이 둘 이상 쌓여
      // 읽고 있는 flooder 가 먼저 끊기는 일이 없다(CI 처럼 이벤트 루프가 바쁘면 그렇게 실패했다).
      const left = () => flooder.messages.some((m) => m.type === 'leave');
      const commits = () => flooder.messages.filter((m) => m.type === 'commit').length;
      for (let seq = 2; seq <= 61 && !left(); seq++) {
        const ops = Array.from({ length: 16 }, () => ({ type: 'update', id: 'penshape1', patch: { points } }));
        flooder.ws.send(JSON.stringify({ type: 'mutate', clientSeq: seq, ops }));
        await vi.waitFor(() => expect(left() || commits() >= seq).toBe(true), { timeout: 5000, interval: 5 });
      }
      await vi.waitFor(() => expect(left()).toBe(true), { timeout: 10_000 });
      flooder.ws.close();
      reader.ws.terminate();
    });
  }, 30_000);
});
