import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { LoaderCircle } from 'lucide-react';
import type { Op, Shape, User } from '../../../shared/protocol.ts';
import { randomId } from '../lib/id.ts';
import type { History } from '../sync/History.ts';
import type { SyncClient } from '../sync/SyncClient.ts';
import { BottomBar } from './BottomBar.tsx';
import { Canvas, isEditable } from './Canvas.tsx';
import { exportPng } from './exportImage.ts';
import { fitBounds, shapeBounds, topZ, unionBounds, zoomAt } from './geometry.ts';
import { COLORS, stylePatch, styleOf } from './style.ts';
import { TextEditor } from './TextEditor.tsx';
import { StylePanel, Toolbar, TOOLS } from './Toolbar.tsx';
import { TopBar } from './TopBar.tsx';
import type { Camera, Style, TextEditing, Tool } from './types.ts';

const DRAWING_TOOLS: Tool[] = ['pen', 'rect', 'ellipse', 'line', 'arrow', 'text'];
const ARROW_KEYS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

type BoardProps = {
  roomId: string;
  client: SyncClient;
  history: History;
  user: User;
  onRename: (name: string) => void;
};

export function Board({ roomId, client, history, user, onRename }: BoardProps) {
  const state = useSyncExternalStore(client.subscribe, client.getState);
  const { shapes } = state;
  const svgRef = useRef<SVGSVGElement>(null);

  const [tool, setTool] = useState<Tool>('select');
  const [style, setStyle] = useState<Style>({ stroke: COLORS[0]!, size: 'm', filled: false });
  const [selected, setSelected] = useState<string[]>([]);
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, zoom: 1 });
  const [editing, setEditing] = useState<TextEditing | null>(null);
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null);
  // blur와 캔버스 클릭이 같은 편집을 두 번 끝내지 않도록, 끝낸 편집을 기억해 둔다.
  const finishedEdits = useRef(new WeakSet<TextEditing>());

  // 남이 지웠거나 실행 취소로 사라진 도형은 선택에서 뺀다.
  const selectedIds = useMemo(() => selected.filter((id) => Object.hasOwn(shapes, id)), [selected, shapes]);

  const showToast = useCallback((text: string) => setToast({ id: Date.now(), text }), []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    client.onReject = () => showToast('서버가 받아들이지 않은 변경이 있어 되돌렸어요');
    return () => {
      client.onReject = null;
    };
  }, [client, showToast]);

  useEffect(() => {
    client.setPresence({ selection: selectedIds });
  }, [client, selectedIds]);

  // 아직 서버에 보내지 못한 변경이 있으면 창을 닫기 전에 확인한다.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (client.getState().pendingCount > 0) e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [client]);

  function viewport() {
    const rect = svgRef.current?.getBoundingClientRect();
    return { width: rect?.width ?? window.innerWidth, height: rect?.height ?? window.innerHeight };
  }

  function fitToContent() {
    const bounds = unionBounds(Object.values(client.getState().shapes).map(shapeBounds));
    const view = viewport();
    setCamera(bounds ? fitBounds(bounds, view) : { x: -view.width / 2, y: -view.height / 2, zoom: 1 });
  }

  function zoomTo(next: (zoom: number) => number) {
    const view = viewport();
    setCamera((c) => zoomAt(c, next(c.zoom), { x: view.width / 2, y: view.height / 2 }));
  }

  // 처음 불러왔을 때 그림 전체가 화면에 들어오게 한다.
  const fitted = useRef(false);
  useEffect(() => {
    if (!state.loaded || fitted.current) return;
    fitted.current = true;
    fitToContent();
  });

  const chooseTool = useCallback((next: Tool) => {
    setTool(next);
    if (next !== 'select') setSelected([]);
  }, []);

  function startEditing(next: TextEditing) {
    setSelected([]);
    setEditing(next);
  }

  function finishEditing(target = editing) {
    if (!target || finishedEdits.current.has(target)) return;
    finishedEdits.current.add(target);
    setEditing((current) => (current === target ? null : current));

    const text = target.text.replace(/\s+$/, '');
    const current = client.getState().shapes;
    if (target.id === null) {
      if (!text) return;
      const shape: Shape = {
        id: randomId(),
        type: 'text',
        x: target.x,
        y: target.y,
        z: topZ(current),
        stroke: target.color,
        strokeWidth: 2,
        text,
        fontSize: target.fontSize,
      };
      history.apply([{ type: 'add', shape }]);
      setTool('select');
      setSelected([shape.id]);
      return;
    }
    const shape = current[target.id];
    if (shape?.type !== 'text') return;
    if (!text) history.apply([{ type: 'delete', id: shape.id }]);
    else if (text !== shape.text) history.apply([{ type: 'update', id: shape.id, patch: { text } }]);
  }

  function deleteSelected() {
    history.apply(selectedIds.map((id): Op => ({ type: 'delete', id })));
    setSelected([]);
  }

  function applyStyle(change: Partial<Style>) {
    setStyle((s) => ({ ...s, ...change }));
    const current = client.getState().shapes;
    const ops: Op[] = [];
    for (const id of selectedIds) {
      const shape = current[id];
      if (!shape) continue;
      const patch = stylePatch(shape, change);
      if (Object.keys(patch).length > 0) ops.push({ type: 'update', id, patch });
    }
    history.apply(ops);
  }

  async function share() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      showToast('링크를 복사했어요. 함께 그릴 사람에게 보내 주세요');
    } catch {
      // 클립보드 API는 https에서만 동작한다.
      window.prompt('이 링크를 복사해서 공유하세요', window.location.href);
    }
  }

  async function exportImage() {
    if (!svgRef.current) return;
    const done = await exportPng(svgRef.current, client.getState().shapes, `whiteboard-${roomId}.png`);
    if (!done) showToast('내보낼 그림이 없어요');
  }

  // 단축키. 매 렌더마다 다시 등록해 항상 최신 상태를 본다.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (editing || isEditable(e.target)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.code === 'KeyZ') {
        e.preventDefault();
        if (e.shiftKey) history.redo();
        else history.undo();
        return;
      }
      if (mod && e.code === 'KeyY') {
        e.preventDefault();
        history.redo();
        return;
      }
      if (mod && e.code === 'KeyA') {
        e.preventDefault();
        setTool('select');
        setSelected(Object.keys(client.getState().shapes));
        return;
      }
      if (mod || e.altKey) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.length > 0) {
        e.preventDefault();
        deleteSelected();
        return;
      }
      if (e.key === 'Escape') {
        setSelected([]);
        setTool('select');
        return;
      }
      const arrow = ARROW_KEYS[e.key];
      if (arrow && selectedIds.length > 0) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const current = client.getState().shapes;
        history.apply(
          selectedIds.flatMap((id): Op[] => {
            const shape = current[id];
            return shape ? [{ type: 'update', id, patch: { x: shape.x + arrow[0] * step, y: shape.y + arrow[1] * step } }] : [];
          }),
        );
        return;
      }
      const match = TOOLS.find((t) => t.code === e.code);
      if (match) chooseTool(match.tool);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const firstSelected = selectedIds.length > 0 ? shapes[selectedIds[0]!] : undefined;
  const showStyle = DRAWING_TOOLS.includes(tool) || (tool === 'select' && firstSelected !== undefined);
  const showFill =
    tool === 'rect' ||
    tool === 'ellipse' ||
    selectedIds.some((id) => shapes[id]?.type === 'rect' || shapes[id]?.type === 'ellipse');

  return (
    <div className="board">
      <Canvas
        svgRef={svgRef}
        client={client}
        history={history}
        shapes={shapes}
        peers={state.peers}
        tool={tool}
        chooseTool={chooseTool}
        style={style}
        selectedIds={selectedIds}
        setSelected={setSelected}
        camera={camera}
        setCamera={setCamera}
        editing={editing}
        startEditing={startEditing}
        finishEditing={() => finishEditing()}
      />
      {editing && (
        <TextEditor
          editing={editing}
          camera={camera}
          onChange={(text) => setEditing((current) => current && { ...current, text })}
          onFinish={() => finishEditing(editing)}
        />
      )}
      <TopBar
        status={state.status}
        pendingCount={state.pendingCount}
        peers={state.peers}
        user={user}
        onRename={onRename}
        onShare={share}
        onExport={exportImage}
      />
      <Toolbar tool={tool} onChoose={chooseTool} />
      {showStyle && (
        <StylePanel
          style={tool === 'select' && firstSelected ? styleOf(firstSelected) : style}
          showFill={showFill}
          onChange={applyStyle}
        />
      )}
      <BottomBar
        zoom={camera.zoom}
        onZoomIn={() => zoomTo((z) => z * 1.25)}
        onZoomOut={() => zoomTo((z) => z / 1.25)}
        onResetZoom={() => zoomTo(() => 1)}
        onFit={fitToContent}
        canUndo={history.canUndo}
        canRedo={history.canRedo}
        onUndo={() => history.undo()}
        onRedo={() => history.redo()}
      />
      {!state.loaded && (
        <div className="loading">
          <LoaderCircle className="spin" size={20} />
          {state.status === 'offline' ? '서버에 연결할 수 없어요. 다시 시도하는 중…' : '보드를 불러오는 중…'}
        </div>
      )}
      {toast && (
        <div key={toast.id} className="toast" role="status">
          {toast.text}
        </div>
      )}
    </div>
  );
}
