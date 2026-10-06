import { memo } from 'react';
import type { Shape } from '../../../shared/protocol.ts';
import { FONT_FAMILY, LINE_HEIGHT, penPath, textSize } from './geometry.ts';

// 보이는 선과 별개로, 클릭을 받는 투명한 두꺼운 선(.hit)을 깐다.
// non-scaling-stroke라서 확대/축소와 관계없이 화면에서 항상 14px 폭으로 잡힌다.
const HIT = {
  className: 'hit',
  stroke: 'transparent',
  strokeWidth: 14,
  vectorEffect: 'non-scaling-stroke',
} as const;

function arrowHead(dx: number, dy: number, strokeWidth: number): string {
  const angle = Math.atan2(dy, dx);
  const size = Math.max(10, strokeWidth * 3.5);
  const left = { x: dx - size * Math.cos(angle - Math.PI / 7), y: dy - size * Math.sin(angle - Math.PI / 7) };
  const right = { x: dx - size * Math.cos(angle + Math.PI / 7), y: dy - size * Math.sin(angle + Math.PI / 7) };
  return `M${left.x} ${left.y}L${dx} ${dy}L${right.x} ${right.y}`;
}

function ShapeBody({ shape }: { shape: Shape }) {
  const stroke = { stroke: shape.stroke, strokeWidth: shape.strokeWidth, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
  switch (shape.type) {
    case 'rect':
      return (
        <>
          <rect width={shape.w} height={shape.h} rx={4} fill={shape.fill ?? 'none'} {...stroke} />
          <rect width={shape.w} height={shape.h} {...HIT} fill="transparent" pointerEvents={shape.fill ? 'all' : 'stroke'} />
        </>
      );
    case 'ellipse': {
      const ellipse = { cx: shape.w / 2, cy: shape.h / 2, rx: shape.w / 2, ry: shape.h / 2 };
      return (
        <>
          <ellipse {...ellipse} fill={shape.fill ?? 'none'} {...stroke} />
          <ellipse {...ellipse} {...HIT} fill="transparent" pointerEvents={shape.fill ? 'all' : 'stroke'} />
        </>
      );
    }
    case 'line': {
      const d = `M0 0L${shape.dx} ${shape.dy}` + (shape.arrow ? arrowHead(shape.dx, shape.dy, shape.strokeWidth) : '');
      return (
        <>
          <path d={d} fill="none" {...stroke} />
          <path d={`M0 0L${shape.dx} ${shape.dy}`} fill="none" {...HIT} pointerEvents="stroke" />
        </>
      );
    }
    case 'pen': {
      const d = penPath(shape.points);
      return (
        <>
          <path d={d} fill="none" {...stroke} />
          <path d={d} fill="none" {...HIT} pointerEvents="stroke" />
        </>
      );
    }
    case 'text': {
      const size = textSize(shape.text, shape.fontSize);
      return (
        <>
          <text fill={shape.stroke} fontSize={shape.fontSize} fontFamily={FONT_FAMILY} style={{ whiteSpace: 'pre' }}>
            {shape.text.split('\n').map((line, i) => (
              // 줄 상자 안에서 글자를 세로 가운데에 둔다(textarea의 line-height와 같은 배치).
              <tspan
                key={i}
                x={0}
                y={(i * LINE_HEIGHT + (LINE_HEIGHT - 1) / 2) * shape.fontSize}
                dominantBaseline="text-before-edge"
              >
                {line || ' '}
              </tspan>
            ))}
          </text>
          <rect className="hit" width={size.width} height={size.height} fill="transparent" pointerEvents="all" />
        </>
      );
    }
  }
}

// 도형 객체는 바뀔 때만 새로 만들어지므로(불변 갱신), 참조 비교만으로 다시 그릴지 결정할 수 있다.
export const ShapeView = memo(function ShapeView({ shape, hidden }: { shape: Shape; hidden?: boolean }) {
  return (
    <g data-id={shape.id} transform={`translate(${shape.x} ${shape.y})`} visibility={hidden ? 'hidden' : undefined}>
      <ShapeBody shape={shape} />
    </g>
  );
});
