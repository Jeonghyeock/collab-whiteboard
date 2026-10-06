import { z } from 'zod';
import { LIMITS } from './limits.ts';

// 서버는 클라이언트가 보낸 메시지를 신뢰하지 않는다. 모든 입력은 이 스키마를 통과해야 한다.
// 클라이언트는 타입만 가져다 쓰므로(import type) zod가 번들에 들어가지 않는다.

// 밑줄을 허용하지 않아 '__proto__' 같은 키가 도형 id로 들어오는 것을 막는다.
export const ShapeIdSchema = z.string().regex(/^[A-Za-z0-9]{8,40}$/);
export const RoomIdSchema = z.string().regex(/^[A-Za-z0-9]{6,40}$/);
export const ClientIdSchema = z.string().regex(/^[A-Za-z0-9]{8,40}$/);

const Coord = z.number().min(-1e6).max(1e6);
const Size = z.number().min(0).max(1e6);
const Color = z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/);

const shapeBase = {
  id: ShapeIdSchema,
  x: Coord,
  y: Coord,
  z: z.number().min(-1e9).max(1e9), // 쌓임 순서. 같으면 id로 정렬한다.
  stroke: Color,
  strokeWidth: z.number().min(1).max(64),
};

const RectSchema = z.strictObject({
  ...shapeBase,
  type: z.literal('rect'),
  w: Size,
  h: Size,
  fill: Color.nullable(),
});
const EllipseSchema = z.strictObject({
  ...shapeBase,
  type: z.literal('ellipse'),
  w: Size,
  h: Size,
  fill: Color.nullable(),
});
// 시작점 (x, y)에서 끝점까지의 상대 벡터 (dx, dy)
const LineSchema = z.strictObject({
  ...shapeBase,
  type: z.literal('line'),
  dx: Coord,
  dy: Coord,
  arrow: z.boolean(),
});
// (x, y) 기준 상대 좌표를 [x0, y0, x1, y1, ...]로 평탄화. 이동은 x, y만 바꾸면 된다.
const PenPoints = z
  .array(Coord)
  .max(LIMITS.maxPenCoords)
  .refine((p) => p.length % 2 === 0, '좌표 개수는 짝수여야 합니다');
const PenSchema = z.strictObject({
  ...shapeBase,
  type: z.literal('pen'),
  points: PenPoints,
});
const TextSchema = z.strictObject({
  ...shapeBase,
  type: z.literal('text'),
  text: z.string().max(LIMITS.maxTextLength),
  fontSize: z.number().min(8).max(200),
});

export const ShapeSchema = z.discriminatedUnion('type', [
  RectSchema,
  EllipseSchema,
  LineSchema,
  PenSchema,
  TextSchema,
]);

// 모든 도형 필드의 합집합. 대상 도형 타입에 맞는 키인지는 서버가 적용 시점에 따로 검사한다.
const ShapePatchSchema = z
  .strictObject({
    x: Coord,
    y: Coord,
    z: shapeBase.z,
    stroke: Color,
    strokeWidth: shapeBase.strokeWidth,
    w: Size,
    h: Size,
    fill: Color.nullable(),
    dx: Coord,
    dy: Coord,
    arrow: z.boolean(),
    points: PenPoints,
    text: TextSchema.shape.text,
    fontSize: TextSchema.shape.fontSize,
  })
  .partial();

export const OpSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('add'), shape: ShapeSchema }),
  z.strictObject({ type: z.literal('update'), id: ShapeIdSchema, patch: ShapePatchSchema }),
  z.strictObject({ type: z.literal('delete'), id: ShapeIdSchema }),
]);

const UserSchema = z.strictObject({
  name: z.string().trim().min(1).max(32),
  color: Color,
});
const PointSchema = z.strictObject({ x: Coord, y: Coord });

export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('hello'),
    roomId: RoomIdSchema,
    clientId: ClientIdSchema,
    // 마지막으로 확정받은 seq. 처음 접속이면 null → 서버가 전체 스냅샷을 보낸다.
    lastSeq: z.number().int().min(0).nullable(),
    user: UserSchema,
  }),
  z.strictObject({
    type: z.literal('mutate'),
    // 클라이언트가 매기는 단조 증가 번호. 재전송된 변경을 서버가 걸러내는 멱등 키다.
    clientSeq: z.number().int().min(1),
    ops: z.array(OpSchema).min(1).max(LIMITS.maxOpsPerMutation),
  }),
  z.strictObject({
    type: z.literal('presence'),
    user: UserSchema,
    cursor: PointSchema.nullable(),
    selection: z.array(ShapeIdSchema).max(LIMITS.maxSelection),
  }),
  z.strictObject({ type: z.literal('ping') }),
]);

export type Shape = z.infer<typeof ShapeSchema>;
export type ShapeType = Shape['type'];
export type ShapePatch = z.infer<typeof ShapePatchSchema>;
export type Op = z.infer<typeof OpSchema>;
export type User = z.infer<typeof UserSchema>;
export type Point = z.infer<typeof PointSchema>;
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type HelloMessage = Extract<ClientMessage, { type: 'hello' }>;

export type Shapes = Readonly<Record<string, Shape>>;

export type Presence = {
  user: User;
  cursor: Point | null;
  selection: string[];
};

// 서버가 순서를 확정한 변경. seq는 방 전체에서 1씩 증가한다.
export type Commit = {
  seq: number;
  clientId: string;
  clientSeq: number;
  ops: Op[];
};

export type ServerMessage =
  | {
      type: 'welcome';
      seq: number;
      // 이 클라이언트의 변경 중 서버가 마지막으로 처리한 clientSeq. 이하의 대기 변경은 버린다.
      lastClientSeq: number;
      sync: { kind: 'snapshot'; shapes: Shapes } | { kind: 'ops'; commits: Commit[] };
      peers: { clientId: string; presence: Presence }[];
    }
  | { type: 'commit'; commit: Commit }
  | { type: 'reject'; clientSeq: number; reason: string }
  | { type: 'presence'; clientId: string; presence: Presence }
  | { type: 'leave'; clientId: string }
  | { type: 'pong' };
