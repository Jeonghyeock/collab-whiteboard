import type { Op, Shape, ShapeType, Shapes } from './protocol.ts';

// 서버와 클라이언트가 똑같이 쓰는 reducer.
// 같은 상태에 같은 순서로 같은 op를 적용하면 결과가 같다 → 모든 클라이언트가 서버 상태로 수렴한다.
//
// 충돌 규칙(서버 도착 순서 기준):
// - update는 패치에 담긴 속성만 덮어쓴다 → 속성 단위 last-writer-wins
// - 이미 삭제된 도형에 대한 update/delete는 아무 일도 하지 않는다 → 삭제가 이긴다
// - 이미 있는 id로의 add는 무시한다
export function applyOps(shapes: Shapes, ops: readonly Op[]): Shapes {
  if (ops.length === 0) return shapes;
  const next: Record<string, Shape> = { ...shapes };
  for (const op of ops) {
    switch (op.type) {
      case 'add':
        if (!Object.hasOwn(next, op.shape.id)) next[op.shape.id] = op.shape;
        break;
      case 'update': {
        const current = next[op.id];
        if (current && Object.hasOwn(next, op.id)) {
          next[op.id] = { ...current, ...op.patch } as Shape;
        }
        break;
      }
      case 'delete':
        delete next[op.id];
        break;
    }
  }
  return next;
}

export function opTargetId(op: Op): string {
  return op.type === 'add' ? op.shape.id : op.id;
}

// 아직 보내지 않은 op 묶음을 압축한다. 드래그 중에는 같은 도형의 x, y가 수십 번 바뀌는데,
// 서로 다른 도형의 op는 순서를 바꿔도 결과가 같으므로 같은 도형의 연속 수정은 하나로 합칠 수 있다.
export function compressOps(ops: readonly Op[]): Op[] {
  const out: Op[] = [];
  const lastIndexById = new Map<string, number>();
  for (const op of ops) {
    const id = opTargetId(op);
    const index = lastIndexById.get(id);
    const prev = index === undefined ? undefined : out[index];
    if (op.type === 'update' && index !== undefined && prev) {
      if (prev.type === 'update') {
        out[index] = { ...prev, patch: { ...prev.patch, ...op.patch } };
        continue;
      }
      if (prev.type === 'add') {
        out[index] = { ...prev, shape: { ...prev.shape, ...op.patch } as Shape };
        continue;
      }
    }
    lastIndexById.set(id, out.length);
    out.push(op);
  }
  return out;
}

const BASE_KEYS = ['x', 'y', 'z', 'stroke', 'strokeWidth'] as const;

// 도형 타입별로 수정 가능한 속성. 서버는 여기에 없는 키가 담긴 패치를 거부한다.
export const PATCH_KEYS: Record<ShapeType, ReadonlySet<string>> = {
  rect: new Set([...BASE_KEYS, 'w', 'h', 'fill']),
  ellipse: new Set([...BASE_KEYS, 'w', 'h', 'fill']),
  line: new Set([...BASE_KEYS, 'dx', 'dy', 'arrow']),
  pen: new Set([...BASE_KEYS, 'points']),
  text: new Set([...BASE_KEYS, 'text', 'fontSize']),
};
