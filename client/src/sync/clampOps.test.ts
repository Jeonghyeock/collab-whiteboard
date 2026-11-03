import { describe, expect, it } from 'vitest';
import { LIMITS } from '../../../shared/limits.ts';
import { ClientMessageSchema, type Op, type Shape } from '../../../shared/protocol.ts';
import { clampOps, clampPoint } from './clampOps.ts';

const rect = (patch: Partial<Shape> = {}): Shape =>
  ({
    id: 'aaaaaaaa',
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

// 서버가 받는지: 스키마를 통과하지 못하면 서버는 연결을 끊는다(1008)
const accepted = (ops: Op[]) => ClientMessageSchema.safeParse({ type: 'mutate', clientSeq: 1, ops }).success;

describe('clampOps', () => {
  it('남이 z 상한의 도형을 두어 topZ 가 상한을 넘어도 서버가 받는 값으로 자른다', () => {
    const ops: Op[] = [{ type: 'add', shape: rect({ z: LIMITS.maxZ + 1 }) }];
    expect(accepted(ops)).toBe(false);
    const clamped = clampOps(ops);
    expect(clamped[0]).toMatchObject({ shape: { z: LIMITS.maxZ } });
    expect(accepted(clamped)).toBe(true);
  });

  it('범위 밖으로 옮기거나 키운 수정과 펜 좌표도 자른다', () => {
    const ops: Op[] = [
      { type: 'update', id: 'aaaaaaaa', patch: { x: 2e6, y: -3e6, w: 5e6, h: -1 } },
      {
        type: 'add',
        shape: { id: 'bbbbbbbb', type: 'pen', x: 0, y: 0, z: 0, stroke: '#000000', strokeWidth: 2, points: [0, 0, 2e6, -2e6] },
      },
      { type: 'update', id: 'cccccccc', patch: { dx: -9e6 } },
    ];
    expect(accepted(ops)).toBe(false);
    const clamped = clampOps(ops);
    expect(clamped[0]).toMatchObject({ patch: { x: 1e6, y: -1e6, w: 1e6, h: 0 } });
    expect(clamped[1]).toMatchObject({ shape: { points: [0, 0, 1e6, -1e6] } });
    expect(clamped[2]).toMatchObject({ patch: { dx: -1e6 } });
    expect(accepted(clamped)).toBe(true);
  });

  it('커서도 서버가 받는 범위로 자른다', () => {
    const presence = (cursor: { x: number; y: number }) =>
      ClientMessageSchema.safeParse({ type: 'presence', user: { name: 'a', color: '#123456' }, cursor, selection: [] }).success;
    expect(presence({ x: 1e6 + 10, y: 0 })).toBe(false);
    expect(clampPoint({ x: 1e6 + 10, y: -2e6 })).toEqual({ x: 1e6, y: -1e6 });
    expect(presence(clampPoint({ x: 1e6 + 10, y: -2e6 }))).toBe(true);
    expect(clampPoint({ x: 5, y: -7 })).toEqual({ x: 5, y: -7 });
  });

  it('NaN 은 0 으로 바꿔 서버가 받는 값으로 만든다', () => {
    const clamped = clampOps([{ type: 'update', id: 'aaaaaaaa', patch: { x: Number.NaN } }]);
    expect(clamped[0]).toMatchObject({ patch: { x: 0 } });
    expect(accepted(clamped)).toBe(true);
  });

  it('범위 안의 값과 삭제는 그대로 둔다', () => {
    const ops: Op[] = [
      { type: 'add', shape: rect({ x: 123.5, z: 7 }) },
      { type: 'update', id: 'aaaaaaaa', patch: { stroke: '#ff0000' } },
      { type: 'delete', id: 'aaaaaaaa' },
    ];
    const clamped = clampOps(ops);
    expect(clamped).toEqual(ops);
    clamped.forEach((op, i) => expect(op).toBe(ops[i])); // 복사하지 않는다
  });
});
