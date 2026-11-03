import { describe, expect, it } from 'vitest';
import { applyOps } from '../../../shared/doc.ts';
import type { Op, Shape, Shapes } from '../../../shared/protocol.ts';
import { History } from './History.ts';

const rect = (id: string, patch: Partial<Shape> = {}): Shape =>
  ({
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
    ...patch,
  }) as Shape;

function setup() {
  let shapes: Shapes = {};
  const history = new History(
    () => shapes,
    (ops: Op[]) => {
      shapes = applyOps(shapes, ops);
    },
  );
  // 다른 사용자의 변경: 기록에 남기지 않고 상태만 바꾼다.
  const remote = (ops: Op[]) => {
    shapes = applyOps(shapes, ops);
  };
  return { history, remote, get: () => shapes };
}

describe('History', () => {
  it('추가를 되돌리면 삭제하고, 다시 실행하면 되살린다', () => {
    const { history, get } = setup();
    history.apply([{ type: 'add', shape: rect('aaaaaaaa') }]);
    history.undo();
    expect(get()).toEqual({});
    history.redo();
    expect(get()['aaaaaaaa']).toEqual(rect('aaaaaaaa'));
  });

  it('드래그 중 여러 번의 이동을 한 번에 되돌린다', () => {
    const { history, get } = setup();
    history.apply([{ type: 'add', shape: rect('aaaaaaaa') }]);
    history.begin();
    for (let x = 1; x <= 10; x++) history.apply([{ type: 'update', id: 'aaaaaaaa', patch: { x } }]);
    history.commit();
    expect(get()['aaaaaaaa']?.x).toBe(10);
    history.undo();
    expect(get()['aaaaaaaa']?.x).toBe(0);
  });

  it('내가 바꾸지 않은 속성은 되돌리지 않는다 (다른 사람의 변경 보존)', () => {
    const { history, remote, get } = setup();
    history.apply([{ type: 'add', shape: rect('aaaaaaaa') }]);
    history.apply([{ type: 'update', id: 'aaaaaaaa', patch: { x: 50 } }]); // 내가 이동
    remote([{ type: 'update', id: 'aaaaaaaa', patch: { stroke: '#ff0000' } }]); // 남이 색 변경
    history.undo();
    expect(get()['aaaaaaaa']).toMatchObject({ x: 0, stroke: '#ff0000' });
  });

  it('남이 지운 도형은 내 수정을 되돌려도 되살리지 않는다', () => {
    const { history, remote, get } = setup();
    history.apply([{ type: 'add', shape: rect('aaaaaaaa') }]);
    history.apply([{ type: 'update', id: 'aaaaaaaa', patch: { x: 50 } }]);
    remote([{ type: 'delete', id: 'aaaaaaaa' }]);
    history.undo();
    expect(get()).toEqual({});
  });

  it('삭제를 되돌리면 지운 모습 그대로 되살린다', () => {
    const { history, get } = setup();
    history.apply([{ type: 'add', shape: rect('aaaaaaaa', { x: 7 }) }]);
    history.apply([{ type: 'delete', id: 'aaaaaaaa' }]);
    history.undo();
    expect(get()['aaaaaaaa']?.x).toBe(7);
  });

  it('새 변경이 생기면 다시 실행 목록을 비운다', () => {
    const { history } = setup();
    history.apply([{ type: 'add', shape: rect('aaaaaaaa') }]);
    history.undo();
    expect(history.canRedo).toBe(true);
    history.apply([{ type: 'add', shape: rect('bbbbbbbb') }]);
    expect(history.canRedo).toBe(false);
  });

  it('드래그 중에 남이 바꾼 다른 속성은 실행 취소가 되돌리지 않는다', () => {
    const { history, remote, get } = setup();
    history.apply([{ type: 'add', shape: rect('aaaaaaaa') }]);
    history.begin();
    history.apply([{ type: 'update', id: 'aaaaaaaa', patch: { x: 10 } }]);
    remote([{ type: 'update', id: 'aaaaaaaa', patch: { stroke: '#ff0000' } }]); // 드래그 도중 남이 색 변경
    history.apply([{ type: 'update', id: 'aaaaaaaa', patch: { x: 20 } }]);
    history.commit();
    history.undo();
    expect(get()['aaaaaaaa']).toMatchObject({ x: 0, stroke: '#ff0000' });
    history.redo();
    expect(get()['aaaaaaaa']).toMatchObject({ x: 20, stroke: '#ff0000' });
  });

  it('드래그 중에 남이 지운 도형은 실행 취소로 되살리지 않는다', () => {
    const { history, remote, get } = setup();
    history.apply([{ type: 'add', shape: rect('aaaaaaaa') }]);
    history.begin();
    history.apply([{ type: 'update', id: 'aaaaaaaa', patch: { x: 10 } }]);
    remote([{ type: 'delete', id: 'aaaaaaaa' }]);
    history.commit();
    history.undo(); // 드래그는 기록되지 않았고, 그 전 동작(추가)은 이미 없어 효과가 없다
    expect(get()).toEqual({});
    history.redo(); // 효과 없던 기록은 버려져, 다시 실행해도 남이 지운 도형이 되살아나지 않는다
    expect(get()).toEqual({});
    expect(history.canUndo || history.canRedo).toBe(false);
  });

  it('효과가 없는 기록은 건너뛰고 그 전 기록을 되돌린다', () => {
    const { history, remote, get } = setup();
    history.apply([{ type: 'add', shape: rect('aaaaaaaa') }]);
    history.apply([{ type: 'add', shape: rect('bbbbbbbb') }]);
    remote([{ type: 'delete', id: 'bbbbbbbb' }]); // 내가 추가한 B 를 남이 지움
    history.undo(); // B 추가 기록은 효과가 없어 버리고, A 추가를 되돌린다
    expect(get()).toEqual({});
    history.redo();
    expect(Object.keys(get())).toEqual(['aaaaaaaa']); // B 는 되살아나지 않는다
  });

  it("'constructor'·'toString' 같은 id 의 도형도 기록하고 되돌린다", () => {
    // 일반 객체로 기록하던 때는 상속 멤버로 읽혀 기록이 빠지거나 전역 Object.keys 를 덮어썼다
    const { history, get } = setup();
    history.apply([{ type: 'add', shape: rect('constructor') }, { type: 'add', shape: rect('toString') }]);
    history.apply([{ type: 'update', id: 'constructor', patch: { x: 30 } }]);
    history.apply([{ type: 'delete', id: 'toString' }]);
    expect(typeof Object.keys).toBe('function');
    history.undo();
    expect(Object.keys(get()).sort()).toEqual(['constructor', 'toString']);
    history.undo();
    expect(get()['constructor']?.x).toBe(0);
  });

  it('결과적으로 아무것도 바뀌지 않은 동작은 기록하지 않는다', () => {
    const { history } = setup();
    history.begin();
    history.apply([{ type: 'add', shape: rect('aaaaaaaa') }]);
    history.apply([{ type: 'delete', id: 'aaaaaaaa' }]);
    history.commit();
    expect(history.canUndo).toBe(false);
  });
});
