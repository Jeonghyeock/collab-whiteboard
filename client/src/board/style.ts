import type { Shape, ShapePatch } from '../../../shared/protocol.ts';
import type { Size, Style } from './types.ts';

export const COLORS = ['#1e1e1e', '#e03131', '#f08c00', '#2f9e44', '#1971c2', '#9c36b5', '#868e96'];

export const STROKE_WIDTH: Record<Size, number> = { s: 2, m: 4, l: 8 };
export const FONT_SIZE: Record<Size, number> = { s: 18, m: 28, l: 44 };

// 채우기는 선 색을 옅게(알파 15%) 쓴다.
export const fillOf = (color: string) => `${color.slice(0, 7)}26`;

function closestSize(table: Record<Size, number>, value: number): Size {
  const sizes = Object.keys(table) as Size[];
  return sizes.reduce((best, size) => (Math.abs(table[size] - value) < Math.abs(table[best] - value) ? size : best));
}

// 선택한 도형의 스타일을 패널에 보여주기 위해 거꾸로 변환한다.
export function styleOf(shape: Shape): Style {
  return {
    stroke: shape.stroke,
    size: shape.type === 'text' ? closestSize(FONT_SIZE, shape.fontSize) : closestSize(STROKE_WIDTH, shape.strokeWidth),
    filled: (shape.type === 'rect' || shape.type === 'ellipse') && shape.fill !== null,
  };
}

// 스타일 패널에서 고른 값을 선택된 도형에 맞는 속성으로 바꾼다. 도형 타입에 없는 속성은 넣지 않는다.
export function stylePatch(shape: Shape, change: { stroke?: string; size?: Size; filled?: boolean }): ShapePatch {
  const patch: ShapePatch = {};
  if (change.stroke !== undefined) {
    patch.stroke = change.stroke;
    if ((shape.type === 'rect' || shape.type === 'ellipse') && shape.fill) patch.fill = fillOf(change.stroke);
  }
  if (change.size !== undefined) {
    if (shape.type === 'text') patch.fontSize = FONT_SIZE[change.size];
    else patch.strokeWidth = STROKE_WIDTH[change.size];
  }
  if (change.filled !== undefined && (shape.type === 'rect' || shape.type === 'ellipse')) {
    patch.fill = change.filled ? fillOf(change.stroke ?? shape.stroke) : null;
  }
  return patch;
}
