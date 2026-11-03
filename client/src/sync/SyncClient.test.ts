import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Op, Shape } from '../../../shared/protocol.ts';
import { startServer, type RunningServer } from '../../../server/app.ts';
import { randomId } from '../lib/id.ts';
import { SyncClient } from './SyncClient.ts';

// 실제 서버와 실제 WebSocket으로 클라이언트 여러 개를 붙여 동기화를 검증한다.

const rect = (id: string, patch: Partial<Shape> = {}): Shape =>
  ({
    id,
    type: 'rect',
    x: 0,
    y: 0,
    z: 0,
    stroke: '#000000',
    strokeWidth: 2,
    w: 10,
    h: 10,
    fill: null,
    ...patch,
  }) as Shape;

let server: RunningServer;
let dataDir: string;
let clients: SyncClient[] = [];
const roomId = () => randomId(10);

function connect(room: string, name = 'tester') {
  const client = new SyncClient({
    url: `ws://localhost:${server.port}/ws`,
    roomId: room,
    user: { name, color: '#336699' },
    sendIntervalMs: 10,
  });
  clients.push(client);
  return client;
}

async function online(...list: SyncClient[]) {
  await vi.waitFor(() => {
    for (const c of list) expect(c.getState().status).toBe('online');
  });
}

// 모두 온라인이고, 보낼 변경이 남지 않았고, 같은 상태를 보고 있을 때까지 기다린다.
async function converged(...list: SyncClient[]) {
  await vi.waitFor(
    () => {
      const [first, ...rest] = list.map((c) => c.getState());
      for (const state of [first, ...rest]) {
        expect(state?.status).toBe('online');
        expect(state?.pendingCount).toBe(0);
      }
      for (const state of rest) expect(state.shapes).toEqual(first?.shapes);
    },
    { timeout: 5000 },
  );
  return list[0]!.getState().shapes;
}

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'whiteboard-test-'));
  server = await startServer({ port: 0, dataDir, saveDelayMs: 20 });
});

afterEach(async () => {
  for (const c of clients) c.close();
  clients = [];
  await server.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe('SyncClient + server', () => {
  it('한 사람이 그린 도형이 다른 사람에게 보인다', async () => {
    const room = roomId();
    const a = connect(room);
    const b = connect(room);
    await online(a, b);
    a.mutate([{ type: 'add', shape: rect('shape001') }]);
    const shapes = await converged(a, b);
    expect(Object.keys(shapes)).toEqual(['shape001']);
  });

  it('스키마 밖 값은 잘라서, 내 화면과 서버·다른 사람이 같은 값을 갖는다', async () => {
    const room = roomId();
    const a = connect(room);
    const b = connect(room);
    await online(a, b);
    a.mutate([{ type: 'add', shape: rect('shape009', { z: 1e9 + 5 }) }]);
    expect(a.getState().shapes['shape009']?.z).toBe(1e9);
    const shapes = await converged(a, b);
    expect(shapes['shape009']?.z).toBe(1e9);
  });

  it('서버 확인 전에 내 화면에 먼저 반영한다 (낙관적 업데이트)', async () => {
    const a = connect(roomId());
    await online(a);
    a.mutate([{ type: 'add', shape: rect('shape001') }]);
    expect(a.getState().shapes['shape001']).toBeDefined();
    expect(a.getState().pendingCount).toBe(1);
  });

  it('같은 도형의 서로 다른 속성을 동시에 고치면 둘 다 반영된다', async () => {
    const room = roomId();
    const a = connect(room);
    const b = connect(room);
    await online(a, b);
    a.mutate([{ type: 'add', shape: rect('shape001') }]);
    await converged(a, b);
    a.mutate([{ type: 'update', id: 'shape001', patch: { x: 100 } }]);
    b.mutate([{ type: 'update', id: 'shape001', patch: { stroke: '#ff0000' } }]);
    const shapes = await converged(a, b);
    expect(shapes['shape001']).toMatchObject({ x: 100, stroke: '#ff0000' });
  });

  it('오프라인 동안의 변경은 다시 연결되면 전송되고, 그동안의 남의 변경도 받는다', async () => {
    const room = roomId();
    const a = connect(room);
    const b = connect(room);
    await online(a, b);

    a.handleNetworkOffline();
    expect(a.getState().status).toBe('offline');
    a.mutate([{ type: 'add', shape: rect('offline1') }]);
    a.mutate([{ type: 'update', id: 'offline1', patch: { x: 5 } }]);
    a.mutate([{ type: 'add', shape: rect('offline2') }]);
    b.mutate([{ type: 'add', shape: rect('fromBBBB') }]);
    await vi.waitFor(() => expect(b.getState().pendingCount).toBe(0));
    expect(a.getState().shapes['fromBBBB']).toBeUndefined();

    a.handleNetworkOnline();
    const shapes = await converged(a, b);
    expect(Object.keys(shapes).sort()).toEqual(['fromBBBB', 'offline1', 'offline2']);
    expect(shapes['offline1']?.x).toBe(5);
  });

  it('서버가 처리했지만 응답을 못 받은 변경을 재전송해도 한 번만 반영된다', async () => {
    const room = roomId();
    const a = connect(room);
    const b = connect(room);
    await online(a, b);
    a.mutate([{ type: 'add', shape: rect('shape001', { x: 0 }) }]);
    await converged(a, b);

    // A의 소켓에서 들어오는 메시지를 버려 "보냈는데 확인을 못 받은" 상황을 만든다.
    const socket = (a as unknown as { ws: WebSocket }).ws;
    socket.onmessage = null;
    a.mutate([{ type: 'update', id: 'shape001', patch: { x: 1 } }]);
    await vi.waitFor(() => expect(b.getState().shapes['shape001']?.x).toBe(1));
    // 그 뒤 B가 같은 속성을 바꾼다. A의 변경이 중복 적용되면 B의 값이 덮어써진다.
    b.mutate([{ type: 'update', id: 'shape001', patch: { x: 2 } }]);
    await vi.waitFor(() => expect(b.getState().pendingCount).toBe(0));
    expect(a.getState().pendingCount).toBe(1);

    a.handleNetworkOffline();
    a.handleNetworkOnline();
    const shapes = await converged(a, b);
    expect(shapes['shape001']?.x).toBe(2);
  });

  it('서버가 거부한 변경은 내 화면에서도 되돌린다', async () => {
    const a = connect(roomId());
    await online(a);
    const rejected = vi.fn();
    a.onReject = rejected;
    a.mutate([{ type: 'add', shape: rect('shape001') }]);
    await vi.waitFor(() => expect(a.getState().pendingCount).toBe(0));

    // 사각형에는 text 속성이 없다.
    a.mutate([{ type: 'update', id: 'shape001', patch: { text: 'hi' } } as Op]);
    expect(a.getState().shapes['shape001']).toHaveProperty('text', 'hi');
    await vi.waitFor(() => expect(rejected).toHaveBeenCalled());
    expect(a.getState().shapes['shape001']).not.toHaveProperty('text');
    expect(a.getState().pendingCount).toBe(0);
  });

  it('서버가 재시작돼도 보드가 남아 있고, 클라이언트는 알아서 다시 붙는다', async () => {
    const room = roomId();
    const a = connect(room);
    await online(a);
    a.mutate([{ type: 'add', shape: rect('shape001') }]);
    await vi.waitFor(() => expect(a.getState().pendingCount).toBe(0));

    const port = server.port;
    await server.close();
    await vi.waitFor(() => expect(a.getState().status).not.toBe('online'));
    server = await startServer({ port, dataDir, saveDelayMs: 20 });

    const fresh = connect(room);
    const shapes = await converged(a, fresh);
    expect(Object.keys(shapes)).toEqual(['shape001']);
  });

  it('무작위 동시 편집과 연결 끊김 뒤에도 모두 같은 상태로 수렴한다', async () => {
    const room = roomId();
    const peers = [connect(room, 'a'), connect(room, 'b'), connect(room, 'c')];
    await online(...peers);

    // 시드 고정 난수: 실패하면 같은 순서로 재현할 수 있다.
    let seed = 42;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const pick = <T,>(list: T[]) => list[Math.floor(random() * list.length)]!;
    const ids = Array.from({ length: 8 }, (_, i) => `shape00${i}`);

    for (let step = 0; step < 300; step++) {
      const client = pick(peers);
      const roll = random();
      if (roll < 0.05) {
        client.handleNetworkOffline();
      } else if (roll < 0.15) {
        client.handleNetworkOnline();
      } else if (roll < 0.35) {
        client.mutate([{ type: 'add', shape: rect(pick(ids), { x: step }) }]);
      } else if (roll < 0.45) {
        client.mutate([{ type: 'delete', id: pick(ids) }]);
      } else {
        client.mutate([
          { type: 'update', id: pick(ids), patch: random() < 0.5 ? { x: step } : { stroke: '#00ff00', y: step } },
        ]);
      }
      if (step % 10 === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    }

    for (const client of peers) client.handleNetworkOnline();
    const shapes = await converged(...peers);
    const observer = connect(room, 'observer');
    expect(await converged(observer)).toEqual(shapes);
  });

  it('같은 선택을 다시 알려도 presence 를 다시 보내지 않는다', async () => {
    // 보드는 도형이 바뀔 때마다(남의 커밋 포함) 같은 선택을 다시 알린다. 고치기 전에는 그때마다 presence 가 나갔다.
    const room = roomId();
    const a = connect(room, 'a');
    const b = connect(room, 'b');
    await online(a, b);
    a.mutate([{ type: 'add', shape: rect('shape001') }]);
    await converged(a, b);
    a.setPresence({ selection: ['shape001'] });
    await vi.waitFor(() => expect([...b.getState().peers.values()][0]?.selection).toEqual(['shape001']));

    let received = 0;
    let last = b.getState().peers;
    b.subscribe(() => {
      if (b.getState().peers !== last) received += 1;
      last = b.getState().peers;
    });
    for (let i = 0; i < 5; i++) {
      b.mutate([{ type: 'update', id: 'shape001', patch: { x: i } }]); // 남의 커밋
      a.setPresence({ selection: ['shape001'] }); // 보드가 다시 알리는 것과 같다
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await converged(a, b);
    expect(received).toBe(0);
  });

  it('새로 그린 도형을 확정 전에 선택해도, 확정된 뒤 그 선택이 다른 사람에게 보인다', async () => {
    // 서버는 아직 없는 도형 id 를 선택에서 거른다. 내 추가가 확정되면 선택을 다시 보내야 한다.
    const room = roomId();
    const a = connect(room, 'a');
    const b = connect(room, 'b');
    await online(a, b);
    a.setPresence({ selection: ['shape002'] }); // 추가보다 먼저 선택을 알린다 → 서버가 거른다
    await vi.waitFor(() => expect([...b.getState().peers.values()][0]?.selection).toEqual([])); // 걸러진 채 도착
    a.mutate([{ type: 'add', shape: rect('shape002') }]);
    await vi.waitFor(() => expect([...b.getState().peers.values()][0]?.selection).toEqual(['shape002']));
  });

  it('남이 지운 선택 도형이 다시 추가되면 선택을 다시 보낸다', async () => {
    const room = roomId();
    const a = connect(room, 'a');
    const b = connect(room, 'b');
    await online(a, b);
    a.mutate([{ type: 'add', shape: rect('shape004') }]);
    await converged(a, b);
    b.mutate([{ type: 'delete', id: 'shape004' }]); // B 가 지움
    await converged(a, b);
    a.setPresence({ selection: ['shape004'] }); // 지워진 뒤라 서버가 거른다
    await vi.waitFor(() => expect([...b.getState().peers.values()][0]?.selection).toEqual([]));
    b.mutate([{ type: 'add', shape: rect('shape004') }]); // B 가 실행 취소로 되살림
    await vi.waitFor(() => expect([...b.getState().peers.values()][0]?.selection).toEqual(['shape004']));
  });

  it('커서·이름이 실제로 바뀔 때만 보내고, 같은 값 뒤의 진짜 변경은 보낸다', async () => {
    const room = roomId();
    const a = connect(room, 'a');
    const b = connect(room, 'b');
    await online(a, b);
    const peer = () => [...b.getState().peers.values()][0];
    a.setPresence({ cursor: { x: 1, y: 2 } });
    await vi.waitFor(() => expect(peer()?.cursor).toEqual({ x: 1, y: 2 }));

    let received = 0;
    let last = b.getState().peers;
    b.subscribe(() => {
      if (b.getState().peers !== last) received += 1;
      last = b.getState().peers;
    });
    a.setPresence({ cursor: { x: 1, y: 2 }, user: { name: 'a', color: '#336699' } }); // 같은 값
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received).toBe(0);
    a.setPresence({ cursor: { x: 3, y: 4 } });
    await vi.waitFor(() => expect(peer()?.cursor).toEqual({ x: 3, y: 4 }));
    a.setPresence({ user: { name: 'a2', color: '#336699' } });
    await vi.waitFor(() => expect(peer()?.user.name).toBe('a2'));
  });
});
