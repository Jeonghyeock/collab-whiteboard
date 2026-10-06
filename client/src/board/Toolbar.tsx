import { Fragment } from 'react';
import {
  Circle,
  Eraser,
  Hand,
  Minus,
  MousePointer2,
  MoveUpRight,
  Pencil,
  Square,
  Type,
  type LucideIcon,
} from 'lucide-react';
import { COLORS } from './style.ts';
import type { Size, Style, Tool } from './types.ts';

// code(KeyR 등)로 단축키를 비교한다. key는 한글 입력 상태에서 'ㄱ'처럼 바뀌어 버린다.
export const TOOLS: { tool: Tool; label: string; shortcut: string; code: string; Icon: LucideIcon }[] = [
  { tool: 'select', label: '선택', shortcut: 'V', code: 'KeyV', Icon: MousePointer2 },
  { tool: 'hand', label: '화면 이동', shortcut: 'H', code: 'KeyH', Icon: Hand },
  { tool: 'pen', label: '펜', shortcut: 'P', code: 'KeyP', Icon: Pencil },
  { tool: 'rect', label: '사각형', shortcut: 'R', code: 'KeyR', Icon: Square },
  { tool: 'ellipse', label: '원', shortcut: 'O', code: 'KeyO', Icon: Circle },
  { tool: 'line', label: '선', shortcut: 'L', code: 'KeyL', Icon: Minus },
  { tool: 'arrow', label: '화살표', shortcut: 'A', code: 'KeyA', Icon: MoveUpRight },
  { tool: 'text', label: '텍스트', shortcut: 'T', code: 'KeyT', Icon: Type },
  { tool: 'eraser', label: '지우개', shortcut: 'E', code: 'KeyE', Icon: Eraser },
];

export function Toolbar({ tool, onChoose }: { tool: Tool; onChoose: (tool: Tool) => void }) {
  return (
    <nav className="panel toolbar" aria-label="도구">
      {TOOLS.map(({ tool: value, label, shortcut, Icon }, i) => (
        <Fragment key={value}>
          {(i === 2 || i === 8) && <span className="toolbar-divider" />}
          <button
            type="button"
            className={`tool-button${value === tool ? ' active' : ''}`}
            title={`${label} (${shortcut})`}
            aria-label={label}
            aria-pressed={value === tool}
            onClick={() => onChoose(value)}
          >
            <Icon size={18} strokeWidth={1.8} />
            <span className="shortcut">{shortcut}</span>
          </button>
        </Fragment>
      ))}
    </nav>
  );
}

const SIZES: { size: Size; label: string; dot: number }[] = [
  { size: 's', label: '가늘게', dot: 4 },
  { size: 'm', label: '보통', dot: 7 },
  { size: 'l', label: '굵게', dot: 11 },
];

export function StylePanel(props: { style: Style; showFill: boolean; onChange: (change: Partial<Style>) => void }) {
  const { style, onChange } = props;
  return (
    <aside className="panel style-panel" aria-label="스타일">
      <div className="style-label">색</div>
      <div className="swatches">
        {COLORS.map((color) => (
          <button
            key={color}
            type="button"
            className={`swatch${color === style.stroke ? ' active' : ''}`}
            style={{ background: color }}
            aria-label={`색 ${color}`}
            aria-pressed={color === style.stroke}
            onClick={() => onChange({ stroke: color })}
          />
        ))}
      </div>
      <div className="style-label">굵기 · 글자 크기</div>
      <div className="segmented">
        {SIZES.map(({ size, label, dot }) => (
          <button
            key={size}
            type="button"
            className={size === style.size ? 'active' : ''}
            title={label}
            aria-label={label}
            aria-pressed={size === style.size}
            onClick={() => onChange({ size })}
          >
            <span className="size-dot" style={{ width: dot, height: dot }} />
          </button>
        ))}
      </div>
      {props.showFill && (
        <>
          <div className="style-label">채우기</div>
          <div className="segmented">
            <button type="button" className={style.filled ? '' : 'active'} onClick={() => onChange({ filled: false })}>
              없음
            </button>
            <button type="button" className={style.filled ? 'active' : ''} onClick={() => onChange({ filled: true })}>
              채움
            </button>
          </div>
        </>
      )}
    </aside>
  );
}
