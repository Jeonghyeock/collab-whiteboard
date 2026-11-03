import { LIMITS } from '../../../shared/limits.ts';
import type { Op, Point, Shape, ShapePatch } from '../../../shared/protocol.ts';

// 서버 스키마의 범위 밖 값(좌표·크기 ±1e6, z ±1e9)을 범위 안으로 자른다.
// 범위 밖 값이 든 변경은 서버가 연결을 끊고(1008), 클라이언트는 같은 변경을 다시 보내 끊김이 끝없이 반복됐다.
// 예: 남이 z=1e9 도형을 두면 새 도형의 topZ 가 1e9+1 이 되고, 카메라를 멀리 옮겨 그리거나 옮기면 좌표가 ±1e6 을 넘는다.
// 상한에 닿은 z 는 같은 값이 되어 id 순으로 쌓인다.
// NaN 은 Math.min/max 를 그대로 통과해 JSON 에서 null 이 되므로 0 으로 바꾼다.
const clamp = (value: number, min: number, max: number) => (Number.isNaN(value) ? 0 : Math.min(max, Math.max(min, value)));
const outside = (value: unknown, min: number, max: number) => typeof value === 'number' && !(value >= min && value <= max);

function needsClamp(fields: Record<string, unknown>): boolean {
  const C = LIMITS.maxCoord;
  return (
    ['x', 'y', 'dx', 'dy'].some((key) => outside(fields[key], -C, C)) ||
    ['w', 'h'].some((key) => outside(fields[key], 0, C)) ||
    outside(fields.z, -LIMITS.maxZ, LIMITS.maxZ) ||
    (Array.isArray(fields.points) && fields.points.some((p) => outside(p, -C, C)))
  );
}

// 범위 안이면 원래 객체를 그대로 돌려준다(펜은 움직일 때마다 점 배열 전체를 보내므로 복사를 아낀다).
function clampFields<T extends Shape | ShapePatch>(fields: T): T {
  if (!needsClamp(fields as Record<string, unknown>)) return fields;
  const out: Record<string, unknown> = { ...fields };
  for (const key of ['x', 'y', 'dx', 'dy']) {
    if (typeof out[key] === 'number') out[key] = clamp(out[key], -LIMITS.maxCoord, LIMITS.maxCoord);
  }
  for (const key of ['w', 'h']) {
    if (typeof out[key] === 'number') out[key] = clamp(out[key], 0, LIMITS.maxCoord);
  }
  if (typeof out.z === 'number') out.z = clamp(out.z, -LIMITS.maxZ, LIMITS.maxZ);
  if (Array.isArray(out.points)) {
    out.points = (out.points as number[]).map((p) => clamp(p, -LIMITS.maxCoord, LIMITS.maxCoord));
  }
  return out as T;
}

export function clampPoint(point: Point): Point {
  return { x: clamp(point.x, -LIMITS.maxCoord, LIMITS.maxCoord), y: clamp(point.y, -LIMITS.maxCoord, LIMITS.maxCoord) };
}

export function clampOps(ops: Op[]): Op[] {
  return ops.map((op) => {
    if (op.type === 'add') {
      const shape = clampFields(op.shape);
      return shape === op.shape ? op : { ...op, shape };
    }
    if (op.type === 'update') {
      const patch = clampFields(op.patch);
      return patch === op.patch ? op : { ...op, patch };
    }
    return op;
  });
}
