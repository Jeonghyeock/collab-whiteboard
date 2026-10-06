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

  it('결과적으로 아무것도 바뀌지 않은 동작은 기록하지 않는다', () => {
    const { history } = setup();
    history.begin();
    history.apply([{ type: 'add', shape: rect('aaaaaaaa') }]);
    history.apply([{ type: 'delete', id: 'aaaaaaaa' }]);
    history.commit();
    expect(history.canUndo).toBe(false);
  });
});
