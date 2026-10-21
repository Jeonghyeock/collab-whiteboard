import { randomUUID } from 'node:crypto';
import { applyOps, PATCH_KEYS } from '../shared/doc.ts';
import { LIMITS } from '../shared/limits.ts';
import type {
  ClientMessage,
  Commit,
  HelloMessage,
  Op,
  Presence,
  ServerMessage,
  ShapeType,
  Shapes,
} from '../shared/protocol.ts';

// 소켓 구현과 분리해 두면 Room을 소켓 없이 테스트할 수 있다.
export interface Connection {
  send(message: ServerMessage): void;
  close(code: number, reason: string): void;
}

export type RoomSnapshot = {
  seq: number;
  shapes: Shapes;
  lastClientSeq: Record<string, number>;
};

type Member = { clientId: string; presence: Presence };

type MutateMessage = Extract<ClientMessage, { type: 'mutate' }>;

export const CLOSE_REPLACED = 4000;
export const CLOSE_ROOM_FULL = 4003;

// 방 하나의 권위 있는 상태. 모든 변경은 여기서 순서(seq)가 정해진다.
export class Room {
  readonly id: string;
  // 메모리에 올릴 때마다 새로 정한다. 비정상 종료로 저장하지 못한 커밋이 있으면, 다시 올린 뒤
  // 같은 seq가 다른 변경에 매겨질 수 있다. 그래서 seq는 같은 epoch 안에서만 비교한다.
  readonly epoch = randomUUID();
  private seq: number;
  private shapes: Shapes;
  // 클라이언트별로 마지막으로 처리한 clientSeq. 재접속 후 같은 변경이 다시 와도 한 번만 적용한다.
  private lastClientSeq: Map<string, number>;
  // 최근 커밋. 잠깐 끊겼던 클라이언트에게 전체 스냅샷 대신 놓친 커밋만 보내는 데 쓴다.
  private log: Commit[] = [];
  private readonly logLimit: number;
  private members = new Map<Connection, Member>();

  // 상태가 바뀔 때마다 호출된다(저장 예약용).
  onChange: (() => void) | null = null;

  constructor(id: string, snapshot?: RoomSnapshot, options: { logLimit?: number } = {}) {
    this.id = id;
    this.seq = snapshot?.seq ?? 0;
    this.shapes = snapshot?.shapes ?? {};
    this.lastClientSeq = new Map(Object.entries(snapshot?.lastClientSeq ?? {}));
    this.logLimit = options.logLimit ?? 1000;
  }

  get memberCount(): number {
    return this.members.size;
  }

  join(conn: Connection, hello: HelloMessage): void {
    // 반쯤 끊긴 이전 연결이 남아 있으면 새 연결로 교체한다.
    for (const [other, member] of this.members) {
      if (member.clientId === hello.clientId) {
        this.members.delete(other);
        other.close(CLOSE_REPLACED, 'replaced by a new connection');
      }
    }
    if (this.members.size >= LIMITS.maxMembersPerRoom) {
      conn.close(CLOSE_ROOM_FULL, 'room is full');
      return;
    }

    const member: Member = {
      clientId: hello.clientId,
      presence: { user: hello.user, cursor: null, selection: [] },
    };
    conn.send({
      type: 'welcome',
      seq: this.seq,
      epoch: this.epoch,
      lastClientSeq: this.lastClientSeq.get(hello.clientId) ?? 0,
      sync: this.catchUp(hello.lastSeq, hello.epoch),
      peers: [...this.members.values()].map((m) => ({ clientId: m.clientId, presence: m.presence })),
    });
    this.members.set(conn, member);
    this.broadcast({ type: 'presence', clientId: member.clientId, presence: member.presence }, conn);
  }

  leave(conn: Connection): void {
    const member = this.members.get(conn);
    if (!member) return;
    this.members.delete(conn);
    this.broadcast({ type: 'leave', clientId: member.clientId });
  }

  handle(conn: Connection, message: ClientMessage): void {
    const member = this.members.get(conn);
    if (!member) return;
    switch (message.type) {
      case 'mutate':
        this.mutate(conn, member, message);
        break;
      case 'presence':
        member.presence = {
          user: message.user,
          cursor: message.cursor,
          // 방에 있는 도형 id만 전달한다. 'toString'처럼 상속된 속성 이름은 받는 쪽에서 도형으로 오인될 수 있다.
          selection: message.selection.filter((id) => Object.hasOwn(this.shapes, id)),
        };
        this.broadcast({ type: 'presence', clientId: member.clientId, presence: member.presence }, conn);
        break;
      case 'ping':
        conn.send({ type: 'pong' });
        break;
      case 'hello':
        break; // 연결당 한 번만 의미가 있다. 이후의 hello는 무시한다.
    }
  }

  toSnapshot(): RoomSnapshot {
    return { seq: this.seq, shapes: this.shapes, lastClientSeq: Object.fromEntries(this.lastClientSeq) };
  }

  private catchUp(
    lastSeq: number | null,
    epoch: string | null | undefined,
  ): Extract<ServerMessage, { type: 'welcome' }>['sync'] {
    const oldest = this.log[0]?.seq ?? this.seq + 1;
    // 클라이언트가 아는 seq 이후의 커밋이 로그에 전부 남아 있을 때만 증분으로 보낸다.
    // 서버가 재시작해 클라이언트가 서버보다 앞서 있는 경우 등은 스냅샷으로 덮어쓴다.
    // epoch가 다르면 같은 seq라도 같은 상태라는 보장이 없으므로 역시 스냅샷을 보낸다.
    if (lastSeq !== null && epoch === this.epoch && lastSeq <= this.seq && lastSeq + 1 >= oldest) {
      return { kind: 'ops', commits: this.log.filter((c) => c.seq > lastSeq) };
    }
    return { kind: 'snapshot', shapes: this.shapes };
  }

  private mutate(conn: Connection, member: Member, message: MutateMessage): void {
    const { clientId } = member;
    // 이미 처리한 변경의 재전송이다. 결과(commit)는 원래 처리 때 이미 방송됐다.
    if (message.clientSeq <= (this.lastClientSeq.get(clientId) ?? 0)) return;
    this.lastClientSeq.set(clientId, message.clientSeq);

    const error = this.validate(message.ops);
    const next = error ? null : applyOps(this.shapes, message.ops);
    if (error || !next || Object.keys(next).length > LIMITS.maxShapesPerRoom) {
      conn.send({ type: 'reject', clientSeq: message.clientSeq, reason: error ?? 'too many shapes' });
      this.onChange?.(); // lastClientSeq가 바뀌었으므로 저장 대상이다.
      return;
    }

    this.shapes = next;
    this.seq += 1;
    const commit: Commit = { seq: this.seq, clientId, clientSeq: message.clientSeq, ops: message.ops };
    this.log.push(commit);
    if (this.log.length > this.logLimit) this.log.shift();
    // 보낸 사람에게도 보낸다. 보낸 사람은 이걸 자기 변경에 대한 확인(ack)으로 쓴다.
    this.broadcast({ type: 'commit', commit });
    this.onChange?.();
  }

  // 스키마 검사는 메시지를 받을 때 끝났다. 여기서는 현재 상태에 비춰 봐야 아는 것만 검사한다.
  private validate(ops: readonly Op[]): string | null {
    const typeInBatch = new Map<string, ShapeType>();
    for (const op of ops) {
      if (op.type === 'add') {
        typeInBatch.set(op.shape.id, op.shape.type);
      } else if (op.type === 'update') {
        const type =
          typeInBatch.get(op.id) ?? (Object.hasOwn(this.shapes, op.id) ? this.shapes[op.id]?.type : undefined);
        if (!type) continue; // 없는 도형에 대한 수정은 reducer에서 무시된다.
        const allowed = PATCH_KEYS[type];
        const invalid = Object.keys(op.patch).find((key) => !allowed.has(key));
        if (invalid) return `'${invalid}' is not a property of ${type}`;
      }
    }
    return null;
  }

  private broadcast(message: ServerMessage, except?: Connection): void {
    for (const conn of this.members.keys()) {
      if (conn !== except) conn.send(message);
    }
  }
}
