import { describe, expect, it } from 'vitest';
import { LIMITS } from './limits.ts';
import { ClientMessageSchema } from './protocol.ts';

const pen = (id: string, points: unknown[]) => ({
  id,
  type: 'pen',
  x: 0,
  y: 0,
  z: 0,
  stroke: '#000000',
  strokeWidth: 2,
  points,
});
const mutate = (ops: unknown[]) => ({ type: 'mutate', clientSeq: 1, ops });
const addPen = (points: unknown[]) => mutate([{ type: 'add', shape: pen('aaaaaaaa', points) }]);

describe('펜 좌표 검증', () => {
  it('범위 안의 숫자이고 짝수 개이면 통과한다', () => {
    expect(ClientMessageSchema.safeParse(addPen([0, 0, 10.5, -3, 1e6, -1e6])).success).toBe(true);
    expect(ClientMessageSchema.safeParse(addPen(new Array(LIMITS.maxPenCoords).fill(1))).success).toBe(true);
  });

  it.each([
    ['홀수 개', [0, 0, 1]],
    ['범위 밖', [0, 1e6 + 1]],
    ['숫자 아님', [0, '1']],
    ['null', [0, null]],
    ['하한 밖', [0, -1e6 - 1]],
    ['빈 칸(희소 배열)', new Array(4)],
    ['상한 초과', new Array(LIMITS.maxPenCoords + 2).fill(1)],
  ])('%s 이면 거절한다', (_, points) => {
    expect(ClientMessageSchema.safeParse(addPen(points)).success).toBe(false);
  });

  it.each([
    ['문자열', 'ab'],
    ['객체', { length: 2 }],
    ['없음', undefined],
  ])('좌표 자리가 배열이 아니면(%s) 거절한다', (_, points) => {
    expect(ClientMessageSchema.safeParse(addPen(points as unknown[])).success).toBe(false);
  });

  it('도형 수정(patch)의 좌표도 같은 규칙이다', () => {
    const update = (points: unknown[]) => mutate([{ type: 'update', id: 'aaaaaaaa', patch: { points } }]);
    expect(ClientMessageSchema.safeParse(update([1, 2])).success).toBe(true);
    expect(ClientMessageSchema.safeParse(update([1, 'x'])).success).toBe(false);
  });

  it('1MB 안쪽 메시지에 잘못된 좌표를 가득 담아도 이슈는 펜마다 하나다', () => {
    // 고치기 전에는 잘못된 원소마다 이슈가 생겨 이 메시지 하나로 이슈 30만여 개(힙 약 200MB)가 만들어졌다
    const ops = Array.from({ length: LIMITS.maxOpsPerMutation }, (_, i) => ({
      type: 'add',
      shape: pen(`pen${String(i).padStart(5, '0')}`, new Array(600).fill('')),
    }));
    const message = mutate(ops);
    expect(JSON.stringify(message).length).toBeLessThan(LIMITS.maxMessageBytes);

    const parsed = ClientMessageSchema.safeParse(message);
    expect(parsed.success).toBe(false);
    expect(parsed.error!.issues.length).toBeLessThanOrEqual(LIMITS.maxOpsPerMutation);
  });

  it.each([
    ['op 배열', { type: 'mutate', clientSeq: 1, ops: new Array(340_000).fill(0) }],
    ['선택 배열', { type: 'presence', user: { name: 'a', color: '#123456' }, cursor: null, selection: new Array(340_000).fill(0) }],
  ])('상한을 넘는 %s 을 1MB 가득 보내도 이슈가 원소마다 생기지 않는다', (_, message) => {
    // zod 4.6.5 는 .max() 를 넘는 배열도 원소마다 이슈를 만들었다(GHSA-mrhx-c7xc-m3w5, 이슈 50만여 개·힙 약 280MB)
    expect(JSON.stringify(message).length).toBeLessThan(LIMITS.maxMessageBytes);
    const parsed = ClientMessageSchema.safeParse(message);
    expect(parsed.success).toBe(false);
    expect(parsed.error!.issues.length).toBeLessThanOrEqual(10);
  });
});
