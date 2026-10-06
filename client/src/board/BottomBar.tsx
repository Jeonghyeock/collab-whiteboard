import type { ReactNode } from 'react';
import { Maximize, Minus, Plus, Redo2, Undo2 } from 'lucide-react';

function IconButton(props: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      className="icon-button"
      title={props.label}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

export function BottomBar(props: {
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetZoom: () => void;
  onFit: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}) {
  return (
    <>
      <div className="bottombar">
        <div className="panel bottombar-group">
          <IconButton label="축소" onClick={props.onZoomOut}>
            <Minus size={16} />
          </IconButton>
          <button type="button" className="zoom-value" title="100%로 보기" onClick={props.onResetZoom}>
            {Math.round(props.zoom * 100)}%
          </button>
          <IconButton label="확대" onClick={props.onZoomIn}>
            <Plus size={16} />
          </IconButton>
          <IconButton label="전체 보기" onClick={props.onFit}>
            <Maximize size={15} />
          </IconButton>
        </div>
        <div className="panel bottombar-group">
          <IconButton label="실행 취소 (Ctrl+Z)" disabled={!props.canUndo} onClick={props.onUndo}>
            <Undo2 size={16} />
          </IconButton>
          <IconButton label="다시 실행 (Ctrl+Shift+Z)" disabled={!props.canRedo} onClick={props.onRedo}>
            <Redo2 size={16} />
          </IconButton>
        </div>
      </div>
      <p className="hint">Space+드래그 화면 이동 · Ctrl+휠 확대 · 빈 곳 더블클릭 텍스트</p>
    </>
  );
}
