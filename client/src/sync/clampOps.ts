import { LIMITS } from '../../../shared/limits.ts';
import type { Op, Point, Shape, ShapePatch } from '../../../shared/protocol.ts';

// 서버 스키마의 범위 밖 값(좌표·크기 ±1e6, z ±1e9)을 범위 안으로 자른다.
// 범위 밖 값이 든 변경은 서버가 연결을 끊고(1008), 클라이언트는 같은 변경을 다시 보내 끊김이 끝없이 반복됐다.
// 예: 남이 z=1e9 도형을 두면 새 도형의 topZ 가 1e9+1 이 되고, 카메라를 멀리 옮겨 그리거나 옮기면 좌표가 ±1e6 을 넘는다.
// 상한에 닿은 z 는 같은 값이 되어 id 순으로 쌓인다.
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function clampFields<T extends Shape | ShapePatch>(fields: T): T {
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
    if (op.type === 'add') return { ...op, shape: clampFields(op.shape) };
    if (op.type === 'update') return { ...op, patch: clampFields(op.patch) };
    return op;
  });
}
