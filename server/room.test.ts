import { describe, expect, it } from 'vitest';
import { Room, type Connection, type RoomSnapshot } from './room.ts';
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

const hello = (clientSecret: string, lastSeq: number | null = null, epoch: string | null = null): HelloMessage => ({
  type: 'hello',
  roomId: 'room0001',
  clientSecret,
  lastSeq,
  epoch,
  user: { name: 'tester', color: '#123456' },
});

// 서버가 비밀 키로 만들어 welcome에 알려 준 공개 id
const idOf = (conn: FakeConnection) => conn.last('welcome')?.clientId;

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
      expect(conn.last('commit')?.commit).toMatchObject({ seq: 1, clientId: idOf(a), clientSeq: 1 });
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

  it('이미 있는 id로의 add(무시됨)는 타입을 바꾸지 않아, 다른 타입의 속성 패치를 거부한다', () => {
    const { room, a } = setup();
    const pen = { id: 'shape001', type: 'pen', x: 0, y: 0, z: 0, stroke: '#000000', strokeWidth: 2, points: [0, 0] } as Shape;
    room.handle(a, { type: 'mutate', clientSeq: 1, ops: [{ type: 'add', shape: pen }] });
    // 고치기 전에는 무시될 add 의 'rect' 를 믿어, 펜에 w·fill 이 붙은 도형이 저장·방송됐다
    room.handle(a, {
      type: 'mutate',
      clientSeq: 2,
      ops: [
        { type: 'add', shape: rect('shape001') },
        { type: 'update', id: 'shape001', patch: { w: 99, fill: '#ff0000' } },
      ],
    });
    expect(a.last('reject')).toMatchObject({ clientSeq: 2 });
    expect(room.toSnapshot().shapes['shape001']).not.toHaveProperty('w');
  });

  it('같은 묶음에서 지웠다가 다른 타입으로 다시 추가하면 새 타입으로 검사한다', () => {
    const { room, a } = setup();
    const pen = { id: 'shape001', type: 'pen', x: 0, y: 0, z: 0, stroke: '#000000', strokeWidth: 2, points: [0, 0] } as Shape;
    room.handle(a, { type: 'mutate', clientSeq: 1, ops: [{ type: 'add', shape: pen }] });
    room.handle(a, {
      type: 'mutate',
      clientSeq: 2,
      ops: [
        { type: 'delete', id: 'shape001' },
        { type: 'add', shape: rect('shape001') },
        { type: 'update', id: 'shape001', patch: { w: 99 } },
      ],
    });
    expect(a.last('reject')).toBeUndefined();
    expect(room.toSnapshot().shapes['shape001']).toMatchObject({ type: 'rect', w: 99 });
  });

  it('재접속한 클라이언트에게 로그에 남아 있으면 놓친 커밋만 보낸다', () => {
    const { room, a } = setup();
    room.handle(a, { type: 'mutate', clientSeq: 1, ops: [{ type: 'add', shape: rect('shape001') }] });
    room.handle(a, { type: 'mutate', clientSeq: 2, ops: [{ type: 'add', shape: rect('shape002') }] });
    const c = new FakeConnection();
    room.join(c, hello('clientCCC', 1, room.epoch));
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
    room.join(c, hello('clientCCC', 1, room.epoch)); // 로그에는 seq 3~5만 남아 있다
    expect(c.last('welcome')?.sync.kind).toBe('snapshot');
  });

  it('클라이언트가 서버보다 앞선 seq를 말하면(서버 재시작 등) 스냅샷을 보낸다', () => {
    const { room } = setup();
    const c = new FakeConnection();
    room.join(c, hello('clientCCC', 42, room.epoch));
    expect(c.last('welcome')?.sync.kind).toBe('snapshot');
  });

  it('저장하기 전에 서버가 죽어 seq가 다시 쓰였으면, 이전 epoch로 들어온 클라이언트에게 스냅샷을 보낸다', () => {
    const { room, a } = setup();
    room.handle(a, { type: 'mutate', clientSeq: 1, ops: [{ type: 'add', shape: rect('shape001') }] });
    const saved = structuredClone(room.toSnapshot()); // 파일에는 seq 1까지만 저장됐다
    room.handle(a, { type: 'mutate', clientSeq: 2, ops: [{ type: 'add', shape: rect('shape002') }] }); // 저장 전에 죽어 잃는다

    // 다시 올린 방에서 B가 먼저 들어와 변경하면, 다른 변경이 seq 2를 받는다.
    const restored = new Room('room0001', saved);
    const b = new FakeConnection();
    restored.join(b, hello('clientBBB', 2, room.epoch));
    restored.handle(b, { type: 'mutate', clientSeq: 1, ops: [{ type: 'add', shape: rect('shape003') }] });
    expect(restored.toSnapshot().seq).toBe(2);

    // seq 2까지 봤던 A가 돌아오면 놓친 커밋이 없어 보이지만, 상태가 다르므로 스냅샷을 받아야 한다.
    const again = new FakeConnection();
    restored.join(again, hello('clientAAA', 2, room.epoch));
    expect(again.last('welcome')?.sync).toEqual({ kind: 'snapshot', shapes: restored.toSnapshot().shapes });
    const noEpoch = new FakeConnection();
    restored.join(noEpoch, hello('clientDDD', 2));
    expect(noEpoch.last('welcome')?.sync.kind).toBe('snapshot');
    // 같은 epoch라면 지금처럼 놓친 커밋만 보낸다.
    const sameEpoch = new FakeConnection();
    restored.join(sameEpoch, hello('clientCCC', 1, restored.epoch));
    expect(sameEpoch.last('welcome')?.sync).toMatchObject({ kind: 'ops', commits: [{ seq: 2 }] });
  });

  it('welcome에 이 클라이언트가 마지막으로 처리된 clientSeq를 담는다', () => {
    const { room, a } = setup();
    room.handle(a, { type: 'mutate', clientSeq: 7, ops: [{ type: 'add', shape: rect('shape001') }] });
    room.leave(a);
    const again = new FakeConnection();
    room.join(again, hello('clientAAA', 0));
    expect(again.last('welcome')?.lastClientSeq).toBe(7);
  });

  it('같은 clientSecret으로 다시 접속하면 이전 연결을 닫는다', () => {
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
    expect(b.last('presence')).toMatchObject({ clientId: idOf(a), presence: { cursor: { x: 1, y: 2 } } });
    expect(a.received.some((m) => m.type === 'presence' && m.clientId === idOf(a))).toBe(false);
    room.leave(a);
    expect(b.last('leave')).toEqual({ type: 'leave', clientId: idOf(a) });
  });

  it('남의 공개 id를 알아도 그 사람의 연결과 중복 제거 기록을 가로챌 수 없다', () => {
    const { room, a, b } = setup();
    // B는 welcome.peers로 A의 공개 id를 안다. 그 id를 비밀 키 자리에 넣어 들어와 본다.
    const victimId = b.last('welcome')?.peers[0]?.clientId;
    expect(victimId).toBe(idOf(a));
    const attacker = new FakeConnection();
    room.join(attacker, hello(victimId!));
    expect(a.closed).toBeNull();
    expect(idOf(attacker)).not.toBe(victimId);

    room.handle(attacker, {
      type: 'mutate',
      clientSeq: Number.MAX_SAFE_INTEGER,
      ops: [{ type: 'delete', id: 'shape999' }],
    });
    room.handle(a, { type: 'mutate', clientSeq: 1, ops: [{ type: 'add', shape: rect('shape001') }] });
    expect(room.toSnapshot().shapes['shape001']).toBeDefined();
    expect(room.toSnapshot().lastClientSeq[victimId!]).toBe(1);

    // 비밀 키는 누구에게 보내는 메시지에도, 파일에 저장하는 스냅샷에도 들어가지 않는다.
    const everything = JSON.stringify([a.received, b.received, attacker.received, room.toSnapshot()]);
    expect(everything).not.toContain('clientAAA');
    expect(everything).not.toContain('clientBBB');
  });

  it('선택 영역은 방에 있는 도형 id만 남겨 전달한다', () => {
    const { room, a, b } = setup();
    room.handle(a, { type: 'mutate', clientSeq: 1, ops: [{ type: 'add', shape: rect('shape001') }] });
    room.handle(a, {
      type: 'presence',
      user: { name: 'A', color: '#123456' },
      cursor: null,
      selection: ['toString', 'shape001', 'missing01'],
    });
    expect(b.last('presence')?.presence.selection).toEqual(['shape001']);
    const c = new FakeConnection();
    room.join(c, hello('clientCCC'));
    const peerA = c.last('welcome')?.peers.find((p) => p.clientId === idOf(a));
    expect(peerA?.presence.selection).toEqual(['shape001']);
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

describe('Room 크기 상한', () => {
  // 범위(±1e6) 안에서 JSON 으로 가장 긴 숫자(25자). 좌표 1000개짜리 펜 하나가 약 26KB 다.
  const longCoord = -0.0000012345678901234567;
  const longSize = 0.0000012345678901234567; // 0 이상에서 가장 긴 숫자(24자)
  const points = new Array(1000).fill(longCoord);
  const pen = (id: string): Shape => ({ id, type: 'pen', x: 0, y: 0, z: 0, stroke: '#000000', strokeWidth: 2, points });
  const maxBytes = 64 * 1024; // 펜 둘은 들어가고 셋은 넘는다
  const bytesOf = (room: Room) => Buffer.byteLength(JSON.stringify(room.toSnapshot().shapes));

  function setupSized(snapshot?: RoomSnapshot) {
    const room = new Room('room0001', snapshot, { maxBytes });
    const a = new FakeConnection();
    const b = new FakeConnection();
    room.join(a, hello('clientAAA'));
    room.join(b, hello('clientBBB'));
    return { room, a, b };
  }

  it('방을 상한보다 크게 만드는 변경은 거부하고, 상태와 크기 셈은 그대로 둔다', () => {
    const { room, a, b } = setupSized();
    room.handle(a, { type: 'mutate', clientSeq: 1, ops: [{ type: 'add', shape: pen('penshape1') }, { type: 'add', shape: pen('penshape2') }] });
    expect(a.last('reject')).toBeUndefined();
    // 고치기 전에는 도형 수만 봐서, 스키마 한도 안의 펜으로 방을 얼마든지 키울 수 있었다
    room.handle(a, { type: 'mutate', clientSeq: 2, ops: [{ type: 'add', shape: pen('penshape3') }] });
    expect(a.last('reject')).toEqual({ type: 'reject', clientSeq: 2, reason: 'room is too large' });
    room.handle(a, { type: 'mutate', clientSeq: 3, ops: [{ type: 'update', id: 'penshape1', patch: { points: [...points, ...points] } }] });
    expect(a.last('reject')).toMatchObject({ clientSeq: 3, reason: 'room is too large' });
    expect(b.received.filter((m) => m.type === 'commit')).toHaveLength(1);
    expect(Object.keys(room.toSnapshot().shapes)).toEqual(['penshape1', 'penshape2']);

    // 크기를 늘리지 않는 변경은 받고, 하나를 지우면 그만큼 다시 넣을 수 있다(거부한 묶음은 크기 셈에 남지 않는다)
    room.handle(a, {
      type: 'mutate',
      clientSeq: 4,
      ops: [
        { type: 'update', id: 'penshape1', patch: { x: 10 } },
        { type: 'delete', id: 'penshape2' },
      ],
    });
    room.handle(a, { type: 'mutate', clientSeq: 5, ops: [{ type: 'add', shape: pen('penshape3') }] });
    expect(a.last('reject')?.clientSeq).toBe(3);
    expect(Object.keys(room.toSnapshot().shapes)).toEqual(['penshape1', 'penshape3']);
    expect(bytesOf(room)).toBeLessThanOrEqual(maxBytes);
  });

  it('크기 어림은 실제 JSON 크기보다 작지 않다(가장 긴 숫자·id, 이스케이프되는 글, 한글)', () => {
    const { room, a } = setupSized();
    const id = (n: number) => `${'x'.repeat(36)}${String(n).padStart(4, '0')}`; // 40자
    const base = { x: longCoord, y: longCoord, z: longCoord, stroke: '#ffffffff', strokeWidth: 1.0000000000000002 };
    const shapes: Shape[] = [];
    for (let n = 0; shapes.length < 400; n++) {
      const kind = n % 5;
      const common = { id: id(n), ...base };
      if (kind === 0) shapes.push({ ...common, type: 'rect', w: longSize, h: longSize, fill: '#ffffffff' });
      if (kind === 1) shapes.push({ ...common, type: 'ellipse', w: longSize, h: longSize, fill: '#ffffffff' });
      if (kind === 2) shapes.push({ ...common, type: 'line', dx: longCoord, dy: longCoord, arrow: false });
      if (kind === 3) shapes.push({ ...common, type: 'pen', points: [longCoord, longCoord] });
      if (kind === 4) shapes.push({ ...common, type: 'text', text: '\u0001가"\\', fontSize: 8.000000000000002 });
    }
    let clientSeq = 0;
    for (let i = 0; i < shapes.length; i += 20) {
      room.handle(a, { type: 'mutate', clientSeq: ++clientSeq, ops: shapes.slice(i, i + 20).map((shape) => ({ type: 'add' as const, shape })) });
    }
    expect(a.last('reject')).toMatchObject({ reason: 'room is too large' });
    expect(bytesOf(room)).toBeLessThanOrEqual(maxBytes);
  });

  it('상한을 이미 넘은 방(상한이 생기기 전 저장 파일)도 크기를 늘리지 않는 변경은 받는다', () => {
    const shapes = { penshape1: pen('penshape1'), penshape2: pen('penshape2'), penshape3: pen('penshape3') };
    const { room, a } = setupSized({ seq: 1, shapes, lastClientSeq: {} });
    room.handle(a, { type: 'mutate', clientSeq: 1, ops: [{ type: 'update', id: 'penshape1', patch: { x: 10 } }] });
    expect(a.last('reject')).toBeUndefined();
    room.handle(a, { type: 'mutate', clientSeq: 2, ops: [{ type: 'add', shape: rect('shape001') }] });
    expect(a.last('reject')).toMatchObject({ clientSeq: 2, reason: 'room is too large' });
    room.handle(a, { type: 'mutate', clientSeq: 3, ops: [{ type: 'delete', id: 'penshape3' }] });
    room.handle(a, { type: 'mutate', clientSeq: 4, ops: [{ type: 'add', shape: rect('shape001') }] });
    expect(a.last('reject')?.clientSeq).toBe(2);
    expect(room.toSnapshot().seq).toBe(4);
  });
});
