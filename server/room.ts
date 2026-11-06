import { createHash, randomUUID } from 'node:crypto';
import { applyOps, opTargetId, PATCH_KEYS } from '../shared/doc.ts';
import { LIMITS } from '../shared/limits.ts';
import type {
  ClientMessage,
  Commit,
  HelloMessage,
  Op,
  Presence,
  ServerMessage,
  Shape,
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

// 다른 사람에게 보이는 id는 비밀 키의 해시로 만든다. 같은 키면 서버가 재시작해도 같은 id가 되고,
// 공개 id만 보고는 키를 알 수 없으니 남의 id로 그 사람의 연결이나 중복 제거 기록을 가로챌 수 없다.
function publicIdOf(clientSecret: string): string {
  return createHash('sha256').update(clientSecret).digest('hex').slice(0, 24);
}

// 방 크기 어림. 도형 하나가 JSON 에서 펜 좌표·글 말고 차지하는 크기(도형 맵의 "id": 와 쉼표 포함)는 id 40자,
// 숫자마다 가장 긴 표기 24자(예: -1.2345678901234567e-300)로 쳐도 약 330바이트라 넉넉히 400 으로 친다.
// 크게 커질 수 있는 값은 펜 좌표와 글뿐이라 그 둘만 실제로 잰다. 그래서 어림은 실제 JSON 크기보다 작지 않다.
const SHAPE_OVERHEAD_BYTES = 400;
function shapeBytes(shape: Shape): number {
  if (shape.type === 'pen') return SHAPE_OVERHEAD_BYTES + JSON.stringify(shape.points).length;
  if (shape.type === 'text') return SHAPE_OVERHEAD_BYTES + Buffer.byteLength(JSON.stringify(shape.text));
  return SHAPE_OVERHEAD_BYTES;
}
// 이 값이 그대로면(이동·색 바꾸기 등) 도형 크기 어림도 그대로다.
const bulkOf = (shape: Shape) => (shape.type === 'pen' ? shape.points : shape.type === 'text' ? shape.text : null);

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
  // 도형 크기 어림(shapeBytes)의 합과 도형별 값. 변경마다 방 전체를 직렬화하지 않고, 바뀐 도형만 다시 잰다.
  private bytes = 0;
  private shapeSizes = new Map<string, number>();
  private readonly maxBytes: number;

  // 상태가 바뀔 때마다 호출된다(저장 예약용).
  onChange: (() => void) | null = null;

  constructor(id: string, snapshot?: RoomSnapshot, options: { logLimit?: number; maxBytes?: number } = {}) {
    this.id = id;
    this.seq = snapshot?.seq ?? 0;
    this.shapes = snapshot?.shapes ?? {};
    this.lastClientSeq = new Map(Object.entries(snapshot?.lastClientSeq ?? {}));
    this.logLimit = options.logLimit ?? 1000;
    this.maxBytes = options.maxBytes ?? LIMITS.maxRoomBytes;
    for (const [shapeId, shape] of Object.entries(this.shapes)) {
      const size = shapeBytes(shape);
      this.shapeSizes.set(shapeId, size);
      this.bytes += size;
    }
  }

  get memberCount(): number {
    return this.members.size;
  }

  join(conn: Connection, hello: HelloMessage): void {
    const clientId = publicIdOf(hello.clientSecret);
    // 반쯤 끊긴 이전 연결이 남아 있으면 새 연결로 교체한다.
    for (const [other, member] of this.members) {
      if (member.clientId === clientId) {
        this.members.delete(other);
        other.close(CLOSE_REPLACED, 'replaced by a new connection');
      }
    }
    if (this.members.size >= LIMITS.maxMembersPerRoom) {
      conn.close(CLOSE_ROOM_FULL, 'room is full');
      return;
    }

    const member: Member = {
      clientId,
      presence: { user: hello.user, cursor: null, selection: [] },
    };
    conn.send({
      type: 'welcome',
      clientId,
      seq: this.seq,
      epoch: this.epoch,
      lastClientSeq: this.lastClientSeq.get(clientId) ?? 0,
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
    // 방 크기 상한. 도형 수만 막으면 스키마 한도 안의 펜(긴 숫자 표기의 좌표)만으로 방 JSON 이 V8 문자열 최대 길이를 넘어,
    // 저장과 새로 들어온 사람의 스냅샷 welcome 이 영영 실패했다. 이미 상한을 넘은 방(상한이 생기기 전 저장 파일)도
    // 크기를 늘리지 않는 변경(이동·삭제 등)은 받는다.
    const sized = next && this.sizeAfter(next, message.ops);
    const tooLarge = !!sized && sized.bytes > this.maxBytes && sized.bytes > this.bytes;
    if (error || !next || !sized || Object.keys(next).length > LIMITS.maxShapesPerRoom || tooLarge) {
      const reason = error ?? (tooLarge ? 'room is too large' : 'too many shapes');
      conn.send({ type: 'reject', clientSeq: message.clientSeq, reason });
      this.onChange?.(); // lastClientSeq가 바뀌었으므로 저장 대상이다.
      return;
    }

    this.shapes = next;
    this.bytes = sized.bytes;
    for (const [shapeId, size] of sized.sizes) {
      if (size === 0) this.shapeSizes.delete(shapeId);
      else this.shapeSizes.set(shapeId, size);
    }
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
    // op를 reducer와 같은 순서·규칙으로 따라가며, 그 시점에 실제로 있는 도형의 타입으로 패치를 검사한다.
    // 이미 있는 id로의 add는 reducer가 무시하므로 타입을 바꾸지 않는다. 그 add의 타입을 믿으면 다른 타입의
    // 속성(펜에 w·fill 등)이 검사를 통과해 스키마에 맞지 않는 도형이 저장·방송됐다.
    const typeInBatch = new Map<string, ShapeType | null>(); // null: 이 묶음에서 지워짐
    const typeOf = (id: string) =>
      typeInBatch.has(id)
        ? (typeInBatch.get(id) ?? undefined)
        : Object.hasOwn(this.shapes, id)
          ? this.shapes[id]?.type
          : undefined;
    for (const op of ops) {
      if (op.type === 'add') {
        if (!typeOf(op.shape.id)) typeInBatch.set(op.shape.id, op.shape.type);
      } else if (op.type === 'delete') {
        typeInBatch.set(op.id, null);
      } else {
        const type = typeOf(op.id);
        if (!type) continue; // 없는 도형에 대한 수정은 reducer에서 무시된다.
        const allowed = PATCH_KEYS[type];
        const invalid = Object.keys(op.patch).find((key) => !allowed.has(key));
        if (invalid) return `'${invalid}' is not a property of ${type}`;
      }
    }
    return null;
  }

  // 묶음을 적용한 뒤의 방 크기 어림. 건드린 도형만 다시 재고, 펜 좌표·글이 그대로인 도형은 이전 값을 쓴다.
  // 그래서 새로 재는 값은 모두 이번 메시지에 담겨 온 것이라, 드는 시간이 메시지 크기에 비례한다.
  private sizeAfter(next: Shapes, ops: readonly Op[]): { bytes: number; sizes: Map<string, number> } {
    const sizes = new Map<string, number>(); // 0: 지워짐
    let bytes = this.bytes;
    for (const op of ops) {
      const id = opTargetId(op);
      if (sizes.has(id)) continue;
      const before = Object.hasOwn(this.shapes, id) ? this.shapes[id] : undefined;
      const after = Object.hasOwn(next, id) ? next[id] : undefined;
      const old = this.shapeSizes.get(id) ?? 0;
      const size = !after ? 0 : before && bulkOf(before) === bulkOf(after) ? old : shapeBytes(after);
      sizes.set(id, size);
      bytes += size - old;
    }
    return { bytes, sizes };
  }

  private broadcast(message: ServerMessage, except?: Connection): void {
    for (const conn of this.members.keys()) {
      if (conn !== except) conn.send(message);
    }
  }
}
