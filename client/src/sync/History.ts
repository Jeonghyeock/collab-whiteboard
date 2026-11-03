import { opTargetId } from '../../../shared/doc.ts';
import type { Op, Shape, Shapes } from '../../../shared/protocol.ts';

// 도형 하나에 대한 기록.
// - whole: 추가·삭제가 섞인 도형. before/after 는 그 시점의 모습(null 은 "없었음")이다.
// - patch: 수정(update)만 한 도형. before/after 는 내가 바꾼 속성들의 값만 담는다.
//   드래그 중에 남이 다른 속성(색 등)을 바꿔도, 실행 취소는 내가 바꾼 속성만 되돌린다.
type Change =
  | { kind: 'whole'; before: Shape | null; after: Shape | null }
  | { kind: 'patch'; before: Record<string, unknown>; after: Record<string, unknown> };
// 도형 id 를 키로 쓰므로 일반 객체가 아니라 Map 을 쓴다. 'constructor'·'toString' 같은 id 도 스키마를 통과하는데,
// 일반 객체에서는 상속된 멤버로 읽혀 기록이 빠지거나 Object.keys 같은 전역을 덮어쓸 수 있다.
type Entry = Map<string, Change>;

// 아직 묶는 중인 기록: 도형별 처음 모습과 지금까지 내가 수정한 속성(null 이면 도형 전체)
type Draft = Map<string, { before: Shape | null; keys: Set<string> | null }>;

const MAX_ENTRIES = 200;

// 협업 환경의 실행 취소: 상태 전체를 되돌리면 다른 사람의 작업까지 지워진다.
// 그래서 "내가 바꾼 도형의 내가 바꾼 속성"만 되돌리는 op를 새로 만들어 보낸다.
export class History {
  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];
  private draft: Draft | null = null;
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
    this.draft ??= new Map();
  }

  commit(): void {
    const draft = this.draft;
    this.draft = null;
    if (!draft) return;
    const shapes = this.getShapes();
    const entry: Entry = new Map();
    for (const [id, { before, keys }] of draft) {
      const current = shapeOf(shapes, id);
      if (keys === null) {
        if (!sameShape(before, current)) entry.set(id, { kind: 'whole', before, after: current });
        continue;
      }
      // 수정만 한 도형인데 그 사이 남이 지웠으면 되돌릴 것이 없다(되돌릴 때 되살리지 않는다).
      if (!before || !current) continue;
      const changed = [...keys].filter((key) => !sameValue(valueOf(before, key), valueOf(current, key)));
      if (changed.length > 0) entry.set(id, { kind: 'patch', before: pick(before, changed), after: pick(current, changed) });
    }
    if (entry.size === 0) return;
    this.undoStack.push(entry);
    if (this.undoStack.length > MAX_ENTRIES) this.undoStack.shift();
    this.redoStack = [];
  }

  // 모든 사용자 변경은 이 함수를 거친다. 바뀌기 직전 모습과 내가 건드린 속성을 기록해 둔 뒤 적용한다.
  apply(ops: Op[]): void {
    if (ops.length === 0) return;
    const standalone = this.draft === null;
    this.begin();
    const draft = this.draft!;
    const shapes = this.getShapes();
    for (const op of ops) {
      const id = opTargetId(op);
      let record = draft.get(id);
      if (!record) {
        record = { before: shapeOf(shapes, id), keys: new Set() };
        draft.set(id, record);
      }
      if (op.type === 'update') {
        for (const key of Object.keys(op.patch)) record.keys?.add(key);
      } else {
        record.keys = null; // 추가·삭제가 섞이면 도형 전체를 기록한다
      }
    }
    this.mutate(ops);
    if (standalone) this.commit();
  }

  // 그 사이 남이 대상을 지우거나 같은 값으로 바꿔 아무 효과가 없는 기록은 건너뛰고 버린다.
  // 버리지 않으면 Ctrl+Z 가 말없이 소모되고, 이어서 다시 실행하면 남이 지운 도형(내 추가 기록)이 되살아났다.
  undo(): void {
    this.step(this.undoStack, this.redoStack, 'undo');
  }

  redo(): void {
    this.step(this.redoStack, this.undoStack, 'redo');
  }

  private step(from: Entry[], to: Entry[], direction: 'undo' | 'redo'): void {
    if (this.draft) return;
    for (let entry = from.pop(); entry; entry = from.pop()) {
      const ops = revertOps(this.getShapes(), entry, direction);
      if (ops.length === 0) continue;
      this.mutate(ops);
      to.push(entry);
      return;
    }
  }
}

// 기록을 되돌리거나(undo: after → before) 다시 실행하는(redo: before → after) op.
// 지금 값과 목표 값이 다른 속성만 보낸다. 그 사이 다른 사람이 바꾼 다른 속성은 건드리지 않는다.
// 수정만 한 기록은 도형이 있을 때만 수정하고, 남이 지운 도형을 되살리지 않는다.
export function revertOps(current: Shapes, entry: Entry, direction: 'undo' | 'redo'): Op[] {
  const ops: Op[] = [];
  for (const [id, change] of entry) {
    const now = shapeOf(current, id);
    if (change.kind === 'patch') {
      const target = direction === 'undo' ? change.before : change.after;
      if (!now) continue;
      const patch: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(target)) {
        if (!sameValue(valueOf(now, key), value)) patch[key] = value;
      }
      if (Object.keys(patch).length > 0) ops.push({ type: 'update', id, patch });
      continue;
    }
    const [from, to] = direction === 'undo' ? [change.after, change.before] : [change.before, change.after];
    if (to === null) {
      if (from !== null && now) ops.push({ type: 'delete', id });
    } else if (from === null) {
      if (!now) ops.push({ type: 'add', shape: to });
    } else if (now) {
      const patch: Record<string, unknown> = {};
      for (const key of Object.keys(to)) {
        if (!sameValue(valueOf(from, key), valueOf(to, key))) patch[key] = valueOf(to, key);
      }
      if (Object.keys(patch).length > 0) ops.push({ type: 'update', id, patch });
    }
  }
  return ops;
}

function shapeOf(shapes: Shapes, id: string): Shape | null {
  return Object.hasOwn(shapes, id) ? (shapes[id] ?? null) : null;
}

function valueOf(shape: Shape, key: string): unknown {
  return (shape as Record<string, unknown>)[key];
}

function pick(shape: Shape, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((key) => [key, valueOf(shape, key)]));
}

function sameShape(a: Shape | null, b: Shape | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => sameValue(valueOf(a, key), valueOf(b, key)));
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, i) => value === b[i]);
  }
  return a === b;
}
