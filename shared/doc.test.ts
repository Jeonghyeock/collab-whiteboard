import { describe, expect, it } from 'vitest';
import { applyOps, compressOps } from './doc.ts';
import type { Shape } from './protocol.ts';

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

describe('applyOps', () => {
  it('add, update, delete를 순서대로 적용한다', () => {
    let shapes = applyOps({}, [{ type: 'add', shape: rect('aaaaaaaa') }]);
    shapes = applyOps(shapes, [{ type: 'update', id: 'aaaaaaaa', patch: { x: 5 } }]);
    expect(shapes['aaaaaaaa']).toMatchObject({ x: 5, y: 0 });
    shapes = applyOps(shapes, [{ type: 'delete', id: 'aaaaaaaa' }]);
    expect(shapes).toEqual({});
  });

  it('서로 다른 속성을 고친 동시 수정은 둘 다 살아남는다 (속성 단위 LWW)', () => {
    const base = applyOps({}, [{ type: 'add', shape: rect('aaaaaaaa') }]);
    const result = applyOps(base, [
      { type: 'update', id: 'aaaaaaaa', patch: { x: 100 } }, // A가 이동
      { type: 'update', id: 'aaaaaaaa', patch: { stroke: '#ff0000' } }, // B가 색 변경
    ]);
    expect(result['aaaaaaaa']).toMatchObject({ x: 100, stroke: '#ff0000' });
  });

  it('같은 속성은 나중에 도착한 쪽이 이긴다', () => {
    const base = applyOps({}, [{ type: 'add', shape: rect('aaaaaaaa') }]);
    const result = applyOps(base, [
      { type: 'update', id: 'aaaaaaaa', patch: { x: 1 } },
      { type: 'update', id: 'aaaaaaaa', patch: { x: 2 } },
    ]);
    expect(result['aaaaaaaa']?.x).toBe(2);
  });

  it('삭제된 도형에 대한 수정은 무시한다 (삭제가 이긴다)', () => {
    const base = applyOps({}, [{ type: 'add', shape: rect('aaaaaaaa') }]);
    const result = applyOps(base, [
      { type: 'delete', id: 'aaaaaaaa' },
      { type: 'update', id: 'aaaaaaaa', patch: { x: 1 } },
    ]);
    expect(result).toEqual({});
  });

  it('이미 있는 id로의 add는 무시한다', () => {
    const base = applyOps({}, [{ type: 'add', shape: rect('aaaaaaaa', { x: 1 }) }]);
    const result = applyOps(base, [{ type: 'add', shape: rect('aaaaaaaa', { x: 99 }) }]);
    expect(result['aaaaaaaa']?.x).toBe(1);
  });

  it('입력 상태를 변경하지 않는다', () => {
    const base = applyOps({}, [{ type: 'add', shape: rect('aaaaaaaa') }]);
    const snapshot = structuredClone(base);
    applyOps(base, [{ type: 'update', id: 'aaaaaaaa', patch: { x: 1 } }]);
    expect(base).toEqual(snapshot);
  });

  it('Object.prototype의 키를 도형으로 착각하지 않는다', () => {
    const result = applyOps({}, [{ type: 'update', id: 'constructor', patch: { x: 1 } }]);
    expect(Object.keys(result)).toEqual([]);
  });
});

describe('compressOps', () => {
  it('같은 도형의 연속 update를 하나로 합친다', () => {
    const ops = compressOps([
      { type: 'update', id: 'aaaaaaaa', patch: { x: 1 } },
      { type: 'update', id: 'bbbbbbbb', patch: { x: 1 } },
      { type: 'update', id: 'aaaaaaaa', patch: { x: 2, y: 3 } },
    ]);
    expect(ops).toEqual([
      { type: 'update', id: 'aaaaaaaa', patch: { x: 2, y: 3 } },
      { type: 'update', id: 'bbbbbbbb', patch: { x: 1 } },
    ]);
  });

  it('add 뒤의 update는 add에 흡수한다', () => {
    const ops = compressOps([
      { type: 'add', shape: rect('aaaaaaaa') },
      { type: 'update', id: 'aaaaaaaa', patch: { w: 50 } },
    ]);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ type: 'add', shape: { w: 50 } });
  });

  it('delete 뒤의 update는 합치지 않는다', () => {
    const ops = compressOps([
      { type: 'delete', id: 'aaaaaaaa' },
      { type: 'update', id: 'aaaaaaaa', patch: { x: 1 } },
    ]);
    expect(ops).toHaveLength(2);
  });

  it('압축 전후의 적용 결과가 같다', () => {
    const base = applyOps({}, [{ type: 'add', shape: rect('bbbbbbbb') }]);
    const ops = [
      { type: 'add', shape: rect('aaaaaaaa') },
      { type: 'update', id: 'bbbbbbbb', patch: { x: 7 } },
      { type: 'update', id: 'aaaaaaaa', patch: { x: 1 } },
      { type: 'update', id: 'aaaaaaaa', patch: { y: 2 } },
      { type: 'update', id: 'bbbbbbbb', patch: { fill: '#00ff00' } },
    ] as const;
    expect(applyOps(base, compressOps(ops))).toEqual(applyOps(base, ops));
  });
});
