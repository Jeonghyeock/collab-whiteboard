import { opTargetId } from '../../../shared/doc.ts';
import type { Op, Shape, Shapes } from '../../../shared/protocol.ts';

// 도형별 변경 전/후 모습. null은 "그 시점에 없었음"이다.
type Entry = { before: Record<string, Shape | null>; after: Record<string, Shape | null> };

const MAX_ENTRIES = 200;

// 협업 환경의 실행 취소: 상태 전체를 되돌리면 다른 사람의 작업까지 지워진다.
// 그래서 "내가 바꾼 도형의 내가 바꾼 속성"만 되돌리는 op를 새로 만들어 보낸다.
export class History {
  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];
  private draft: Record<string, Shape | null> | null = null;
  private readonly getShapes: () => Shapes;
  private readonly mutate: (ops: Op[]) => void;

  constructor(getShapes: () => Shapes, mutate: (ops: Op[]) => void) {
    this.getShapes = getShapes;
    this.mutate = mutate;
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }

  // 드래그처럼 여러 번 나눠 보내는 변경을 실행 취소 한 번으로 묶는다.
  begin(): void {
    this.draft ??= {};
  }

  commit(): void {
    const before = this.draft;
    this.draft = null;
    if (!before) return;
    const shapes = this.getShapes();
    const after: Record<string, Shape | null> = {};
    let changed = false;
    for (const id of Object.keys(before)) {
      after[id] = shapeOf(shapes, id);
      if (!sameShape(before[id] ?? null, after[id])) changed = true;
    }
    if (!changed) return;
    this.undoStack.push({ before, after });
    if (this.undoStack.length > MAX_ENTRIES) this.undoStack.shift();
    this.redoStack = [];
  }

  // 모든 사용자 변경은 이 함수를 거친다. 바뀌기 직전 모습을 기록해 둔 뒤 적용한다.
  apply(ops: Op[]): void {
    if (ops.length === 0) return;
    const standalone = this.draft === null;
    this.begin();
    const shapes = this.getShapes();
    for (const op of ops) {
      const id = opTargetId(op);
      if (this.draft && !Object.hasOwn(this.draft, id)) this.draft[id] = shapeOf(shapes, id);
    }
    this.mutate(ops);
    if (standalone) this.commit();
  }

  undo(): void {
    if (this.draft) return;
    const entry = this.undoStack.pop();
    if (!entry) return;
    this.mutate(diffOps(this.getShapes(), entry.after, entry.before));
    this.redoStack.push(entry);
  }

  redo(): void {
    if (this.draft) return;
    const entry = this.redoStack.pop();
    if (!entry) return;
    this.mutate(diffOps(this.getShapes(), entry.before, entry.after));
    this.undoStack.push(entry);
  }
}

// from → to로 바뀐 속성만 to의 값으로 되돌리는 op. 그 사이 다른 사람이 바꾼 속성은 건드리지 않는다.
export function diffOps(
  current: Shapes,
  from: Record<string, Shape | null>,
  to: Record<string, Shape | null>,
): Op[] {
  const ops: Op[] = [];
  for (const id of Object.keys(to)) {
    const source = from[id] ?? null;
    const target = to[id] ?? null;
    const exists = shapeOf(current, id) !== null;
    if (target === null) {
      if (source !== null && exists) ops.push({ type: 'delete', id });
    } else if (source === null) {
      if (!exists) ops.push({ type: 'add', shape: target });
    } else if (exists) {
      const patch: Record<string, unknown> = {};
      for (const key of Object.keys(target) as (keyof Shape)[]) {
        if (!sameValue(source[key], target[key])) patch[key] = target[key];
      }
      if (Object.keys(patch).length > 0) ops.push({ type: 'update', id, patch });
    }
  }
  return ops;
}

function shapeOf(shapes: Shapes, id: string): Shape | null {
  return Object.hasOwn(shapes, id) ? (shapes[id] ?? null) : null;
}

function sameShape(a: Shape | null, b: Shape | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = Object.keys(a) as (keyof Shape)[];
  return keys.length === Object.keys(b).length && keys.every((key) => sameValue(a[key], b[key]));
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, i) => value === b[i]);
  }
  return a === b;
}
