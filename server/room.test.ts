import { describe, expect, it } from 'vitest';
import { Room, type Connection } from './room.ts';
import type { ClientMessage, HelloMessage, ServerMessage, Shape } from '../shared/protocol.ts';

class FakeConnection implements Connection {
  received: ServerMessage[] = [];
  closed: { code: number; reason: string } | null = null;
  send(message: ServerMessage) {
    this.received.push(message);
  }
  close(code: number, reason: string) {
    this.closed = { code, reason };
  }
  last<T extends ServerMessage['type']>(type: T) {
    return this.received.filter((m) => m.type === type).at(-1) as Extract<ServerMessage, { type: T }> | undefined;
  }
}

const hello = (clientId: string, lastSeq: number | null = null): HelloMessage => ({
  type: 'hello',
  roomId: 'room0001',
  clientId,
  lastSeq,
  user: { name: clientId, color: '#123456' },
});

const rect = (id: string): Shape => ({
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
});

function setup() {
  const room = new Room('room0001', undefined, { logLimit: 3 });
  const a = new FakeConnection();
  const b = new FakeConnection();
  room.join(a, hello('clientAAA'));
  room.join(b, hello('clientBBB'));
  return { room, a, b };
}

describe('Room', () => {
  it('변경에 seq를 매기고 보낸 사람을 포함한 모두에게 방송한다', () => {
    const { room, a, b } = setup();
    room.handle(a, { type: 'mutate', clientSeq: 1, ops: [{ type: 'add', shape: rect('shape001') }] });
    for (const conn of [a, b]) {
      expect(conn.last('commit')?.commit).toMatchObject({ seq: 1, clientId: 'clientAAA', clientSeq: 1 });
    }
    expect(room.toSnapshot().shapes['shape001']).toBeDefined();
  });

  it('이미 처리한 clientSeq가 다시 오면 무시한다 (재전송 중복 제거)', () => {
    const { room, a } = setup();
    const mutate: ClientMessage = { type: 'mutate', clientSeq: 1, ops: [{ type: 'add', shape: rect('shape001') }] };
    room.handle(a, mutate);
    room.handle(a, { type: 'mutate', clientSeq: 2, ops: [{ type: 'delete', id: 'shape001' }] });
    room.handle(a, mutate); // 응답을 못 받았다고 생각한 클라이언트의 재전송
    expect(room.toSnapshot().seq).toBe(2);
    expect(room.toSnapshot().shapes).toEqual({});
  });

  it('도형 타입에 없는 속성을 고치려 하면 거부하고 상태를 바꾸지 않는다', () => {
    const { room, a, b } = setup();
    room.handle(a, { type: 'mutate', clientSeq: 1, ops: [{ type: 'add', shape: rect('shape001') }] });
    room.handle(a, { type: 'mutate', clientSeq: 2, ops: [{ type: 'update', id: 'shape001', patch: { text: 'hi' } }] });
    expect(a.last('reject')).toMatchObject({ clientSeq: 2 });
    expect(b.received.filter((m) => m.type === 'commit')).toHaveLength(1);
    expect(room.toSnapshot().seq).toBe(1);
  });

  it('같은 묶음에서 추가한 도형의 타입으로 패치를 검사한다', () => {
    const { room, a } = setup();
    room.handle(a, {
      type: 'mutate',
      clientSeq: 1,
      ops: [
        { type: 'add', shape: rect('shape001') },
        { type: 'update', id: 'shape001', patch: { w: 99 } },
      ],
    });
    expect(a.last('reject')).toBeUndefined();
    expect(room.toSnapshot().shapes['shape001']).toMatchObject({ w: 99 });
  });

  it('재접속한 클라이언트에게 로그에 남아 있으면 놓친 커밋만 보낸다', () => {
    const { room, a } = setup();
    room.handle(a, { type: 'mutate', clientSeq: 1, ops: [{ type: 'add', shape: rect('shape001') }] });
    room.handle(a, { type: 'mutate', clientSeq: 2, ops: [{ type: 'add', shape: rect('shape002') }] });
    const c = new FakeConnection();
    room.join(c, hello('clientCCC', 1));
    const welcome = c.last('welcome');
    expect(welcome?.sync.kind).toBe('ops');
    expect(welcome?.sync.kind === 'ops' && welcome.sync.commits.map((x) => x.seq)).toEqual([2]);
  });

  it('놓친 커밋이 로그에서 밀려났으면 전체 스냅샷을 보낸다', () => {
    const { room, a } = setup();
    for (let i = 1; i <= 5; i++) {
      room.handle(a, { type: 'mutate', clientSeq: i, ops: [{ type: 'add', shape: rect(`shape00${i}`) }] });
    }
    const c = new FakeConnection();
    room.join(c, hello('clientCCC', 1)); // 로그에는 seq 3~5만 남아 있다
    expect(c.last('welcome')?.sync.kind).toBe('snapshot');
  });

  it('클라이언트가 서버보다 앞선 seq를 말하면(서버 재시작 등) 스냅샷을 보낸다', () => {
    const { room } = setup();
    const c = new FakeConnection();
    room.join(c, hello('clientCCC', 42));
    expect(c.last('welcome')?.sync.kind).toBe('snapshot');
  });

  it('welcome에 이 클라이언트가 마지막으로 처리된 clientSeq를 담는다', () => {
    const { room, a } = setup();
    room.handle(a, { type: 'mutate', clientSeq: 7, ops: [{ type: 'add', shape: rect('shape001') }] });
    room.leave(a);
    const again = new FakeConnection();
    room.join(again, hello('clientAAA', 0));
    expect(again.last('welcome')?.lastClientSeq).toBe(7);
  });

  it('같은 clientId로 다시 접속하면 이전 연결을 닫는다', () => {
    const { room, a } = setup();
    const again = new FakeConnection();
    room.join(again, hello('clientAAA'));
    expect(a.closed?.code).toBe(4000);
    expect(room.memberCount).toBe(2);
  });

  it('커서는 본인을 제외한 사람에게만 전달하고, 나가면 알린다', () => {
    const { room, a, b } = setup();
    room.handle(a, {
      type: 'presence',
      user: { name: 'A', color: '#123456' },
      cursor: { x: 1, y: 2 },
      selection: [],
    });
    expect(b.last('presence')).toMatchObject({ clientId: 'clientAAA', presence: { cursor: { x: 1, y: 2 } } });
    expect(a.received.some((m) => m.type === 'presence' && m.clientId === 'clientAAA')).toBe(false);
    room.leave(a);
    expect(b.last('leave')).toEqual({ type: 'leave', clientId: 'clientAAA' });
  });

  it('스냅샷에서 복원하면 seq와 중복 제거 정보가 이어진다', () => {
    const { room, a } = setup();
    room.handle(a, { type: 'mutate', clientSeq: 1, ops: [{ type: 'add', shape: rect('shape001') }] });
    const restored = new Room('room0001', structuredClone(room.toSnapshot()));
    const conn = new FakeConnection();
    restored.join(conn, hello('clientAAA', 1));
    restored.handle(conn, { type: 'mutate', clientSeq: 1, ops: [{ type: 'delete', id: 'shape001' }] });
    expect(restored.toSnapshot()).toMatchObject({ seq: 1, shapes: { shape001: {} } });
  });
});
