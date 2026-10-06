import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
  type SetStateAction,
} from 'react';
import { LIMITS } from '../../../shared/limits.ts';
import type { Point, Presence, Shape, Shapes } from '../../../shared/protocol.ts';
import { randomId } from '../lib/id.ts';
import type { History } from '../sync/History.ts';
import type { SyncClient } from '../sync/SyncClient.ts';
import {
  boundsFromPoints,
  intersects,
  screenToWorld,
  shapeBounds,
  sortShapes,
  textSize,
  topZ,
  worldToScreen,
  zoomAt,
  type Bounds,
} from './geometry.ts';
import { ShapeView } from './ShapeView.tsx';
import { fillOf, FONT_SIZE, STROKE_WIDTH } from './style.ts';
import type { Camera, Style, TextEditing, Tool } from './types.ts';

type Corner = 'nw' | 'ne' | 'sw' | 'se';
type LineShape = Extract<Shape, { type: 'line' }>;
type BoxShape = Extract<Shape, { type: 'rect' | 'ellipse' }>;

// 포인터를 누르고 있는 동안의 상태. 렌더링과 무관하므로 ref에 둔다.
type Interaction =
  | { kind: 'none' }
  | { kind: 'pan'; start: Point; camera: Camera }
  | { kind: 'move'; start: Point; origins: Map<string, Point> }
  | { kind: 'resize'; corner: Corner; origin: BoxShape }
  | { kind: 'endpoint'; end: 'start' | 'end'; origin: LineShape }
  | { kind: 'marquee'; start: Point; base: string[] }
  | { kind: 'create'; id: string; start: Point }
  | { kind: 'pen'; id: string; origin: Point; points: number[] }
  | { kind: 'erase' };

type CanvasProps = {
  svgRef: RefObject<SVGSVGElement | null>;
  client: SyncClient;
  history: History;
  shapes: Shapes;
  peers: ReadonlyMap<string, Presence>;
  tool: Tool;
  chooseTool: (tool: Tool) => void;
  style: Style;
  selectedIds: string[];
  setSelected: (ids: string[]) => void;
  camera: Camera;
  setCamera: Dispatch<SetStateAction<Camera>>;
  editing: TextEditing | null;
  startEditing: (editing: TextEditing) => void;
  finishEditing: () => void;
};

const round = (value: number) => Math.round(value * 100) / 100;

export function Canvas(props: CanvasProps) {
  const { svgRef, client, history, shapes, peers, tool, style, selectedIds, camera, setCamera, editing } = props;
  const interaction = useRef<Interaction>({ kind: 'none' });
  const [marquee, setMarquee] = useState<Bounds | null>(null);
  const [panning, setPanning] = useState(false);
  const [spaceHeld, setSpaceHeld] = useState(false);

  const sorted = useMemo(() => sortShapes(shapes), [shapes]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  // 포인터 이벤트 사이에 서버 변경이 끼어들 수 있으므로, 계산할 때는 항상 최신 상태를 읽는다.
  const latest = () => client.getState().shapes;

  // 스페이스를 누른 채 드래그하면 화면 이동
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || isEditable(e.target)) return;
      e.preventDefault();
      setSpaceHeld(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceHeld(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  // 휠: 화면 이동, Ctrl(⌘)+휠 또는 트랙패드 핀치: 확대/축소. preventDefault가 필요해 passive: false로 직접 등록한다.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : 1;
      const rect = svg.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        const delta = Math.max(-50, Math.min(50, e.deltaY * unit));
        const anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        setCamera((c) => zoomAt(c, c.zoom * Math.exp(-delta * 0.01), anchor));
      } else {
        const dx = (e.shiftKey ? e.deltaY : e.deltaX) * unit;
        const dy = (e.shiftKey ? 0 : e.deltaY) * unit;
        setCamera((c) => ({ ...c, x: c.x + dx / c.zoom, y: c.y + dy / c.zoom }));
      }
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [svgRef, setCamera]);

  function toWorld(e: { clientX: number; clientY: number }): Point {
    const rect = svgRef.current!.getBoundingClientRect();
    return screenToWorld(camera, { x: e.clientX - rect.left, y: e.clientY - rect.top });
  }

  function newShapeBase(p: Point) {
    return {
      id: randomId(),
      x: round(p.x),
      y: round(p.y),
      z: topZ(latest()),
      stroke: style.stroke,
      strokeWidth: STROKE_WIDTH[style.size],
    };
  }

  function editText(shape: Shape) {
    if (shape.type !== 'text') return;
    props.startEditing({ id: shape.id, x: shape.x, y: shape.y, text: shape.text, fontSize: shape.fontSize, color: shape.stroke });
  }

  function newText(p: Point) {
    const fontSize = FONT_SIZE[style.size];
    props.startEditing({ id: null, x: round(p.x), y: round(p.y - fontSize * 0.6), text: '', fontSize, color: style.stroke });
  }

  function eraseAt(e: { clientX: number; clientY: number }) {
    const id = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-id]')?.getAttribute('data-id');
    if (id && Object.hasOwn(latest(), id)) history.apply([{ type: 'delete', id }]);
  }

  function onPointerDown(e: PointerEvent<SVGSVGElement>) {
    if (e.button === 2) return;
    // 글을 쓰던 중에 캔버스를 누르면 글쓰기만 끝낸다.
    if (editing) {
      props.finishEditing();
      return;
    }
    const svg = e.currentTarget;
    const target = e.target as Element;
    const hitId = target.closest('[data-id]')?.getAttribute('data-id') ?? null;
    const handle = target.closest('[data-handle]')?.getAttribute('data-handle') ?? null;
    const p = toWorld(e);
    svg.setPointerCapture(e.pointerId);

    if (e.button === 1 || tool === 'hand' || spaceHeld) {
      interaction.current = { kind: 'pan', start: { x: e.clientX, y: e.clientY }, camera };
      setPanning(true);
      return;
    }

    switch (tool) {
      case 'select': {
        const single = selectedIds.length === 1 ? latest()[selectedIds[0]!] : undefined;
        if (handle && single) {
          history.begin();
          if (single.type === 'line') {
            interaction.current = { kind: 'endpoint', end: handle as 'start' | 'end', origin: single };
          } else if (single.type === 'rect' || single.type === 'ellipse') {
            interaction.current = { kind: 'resize', corner: handle as Corner, origin: single };
          }
          return;
        }
        if (hitId) {
          let next = selectedIds;
          if (e.shiftKey) {
            next = selectedSet.has(hitId) ? selectedIds.filter((id) => id !== hitId) : [...selectedIds, hitId];
          } else if (!selectedSet.has(hitId)) {
            next = [hitId];
          }
          props.setSelected(next);
          if (!next.includes(hitId)) return;
          const current = latest();
          const origins = new Map<string, Point>();
          for (const id of next) {
            const shape = current[id];
            if (shape) origins.set(id, { x: shape.x, y: shape.y });
          }
          history.begin();
          interaction.current = { kind: 'move', start: p, origins };
          return;
        }
        const base = e.shiftKey ? selectedIds : [];
        props.setSelected(base);
        interaction.current = { kind: 'marquee', start: p, base };
        setMarquee(boundsFromPoints(p, p));
        return;
      }
      case 'pen': {
        const shape: Shape = { ...newShapeBase(p), type: 'pen', points: [0, 0] };
        history.begin();
        history.apply([{ type: 'add', shape }]);
        interaction.current = { kind: 'pen', id: shape.id, origin: { x: shape.x, y: shape.y }, points: [0, 0] };
        return;
      }
      case 'rect':
      case 'ellipse':
      case 'line':
      case 'arrow': {
        const base = newShapeBase(p);
        const shape: Shape =
          tool === 'line' || tool === 'arrow'
            ? { ...base, type: 'line', dx: 0, dy: 0, arrow: tool === 'arrow' }
            : { ...base, type: tool, w: 0, h: 0, fill: style.filled ? fillOf(style.stroke) : null };
        history.begin();
        history.apply([{ type: 'add', shape }]);
        interaction.current = { kind: 'create', id: shape.id, start: { x: shape.x, y: shape.y } };
        return;
      }
      case 'text': {
        const existing = hitId ? latest()[hitId] : undefined;
        if (existing?.type === 'text') editText(existing);
        else newText(p);
        return;
      }
      case 'eraser':
        history.begin();
        interaction.current = { kind: 'erase' };
        eraseAt(e);
        return;
    }
  }

  function onPointerMove(e: PointerEvent<SVGSVGElement>) {
    const p = toWorld(e);
    client.setPresence({ cursor: { x: round(p.x), y: round(p.y) } });
    const it = interaction.current;

    switch (it.kind) {
      case 'pan':
        setCamera({
          ...it.camera,
          x: it.camera.x - (e.clientX - it.start.x) / it.camera.zoom,
          y: it.camera.y - (e.clientY - it.start.y) / it.camera.zoom,
        });
        break;
      case 'move': {
        const dx = p.x - it.start.x;
        const dy = p.y - it.start.y;
        history.apply(
          [...it.origins].map(([id, o]) => ({ type: 'update' as const, id, patch: { x: round(o.x + dx), y: round(o.y + dy) } })),
        );
        break;
      }
      case 'resize': {
        const o = it.origin;
        // 잡은 모서리의 반대편 모서리를 고정점으로 삼는다.
        const fixed = { x: it.corner.includes('w') ? o.x + o.w : o.x, y: it.corner.includes('n') ? o.y + o.h : o.y };
        const b = boundsFromPoints(fixed, e.shiftKey ? squareCorner(fixed, p) : p);
        history.apply([
          {
            type: 'update',
            id: o.id,
            patch: { x: round(b.minX), y: round(b.minY), w: round(b.maxX - b.minX), h: round(b.maxY - b.minY) },
          },
        ]);
        break;
      }
      case 'endpoint': {
        const o = it.origin;
        const patch =
          it.end === 'end'
            ? { dx: round(p.x - o.x), dy: round(p.y - o.y) }
            : { x: round(p.x), y: round(p.y), dx: round(o.x + o.dx - p.x), dy: round(o.y + o.dy - p.y) };
        history.apply([{ type: 'update', id: o.id, patch }]);
        break;
      }
      case 'create': {
        const shape = latest()[it.id];
        if (!shape) break;
        if (shape.type === 'line') {
          const end = e.shiftKey ? snapAngle(it.start, p) : p;
          history.apply([{ type: 'update', id: it.id, patch: { dx: round(end.x - it.start.x), dy: round(end.y - it.start.y) } }]);
        } else {
          const b = boundsFromPoints(it.start, e.shiftKey ? squareCorner(it.start, p) : p);
          history.apply([
            {
              type: 'update',
              id: it.id,
              patch: { x: round(b.minX), y: round(b.minY), w: round(b.maxX - b.minX), h: round(b.maxY - b.minY) },
            },
          ]);
        }
        break;
      }
      case 'pen': {
        // 브라우저가 한 프레임에 합쳐 보낸 중간 좌표까지 써야 빠르게 그어도 획이 각지지 않는다.
        const events = e.nativeEvent.getCoalescedEvents?.() ?? [e.nativeEvent];
        let points = it.points;
        for (const event of events.length > 0 ? events : [e.nativeEvent]) {
          const world = toWorld(event);
          const x = round(world.x - it.origin.x);
          const y = round(world.y - it.origin.y);
          const lastX = points[points.length - 2]!;
          const lastY = points[points.length - 1]!;
          if (Math.hypot(x - lastX, y - lastY) < 2 / camera.zoom) continue;
          if (points.length + 2 > LIMITS.maxPenCoords) break;
          points = [...points, x, y];
        }
        if (points !== it.points) {
          it.points = points;
          history.apply([{ type: 'update', id: it.id, patch: { points } }]);
        }
        break;
      }
      case 'marquee': {
        const b = boundsFromPoints(it.start, p);
        setMarquee(b);
        const hits = sorted.filter((shape) => intersects(shapeBounds(shape), b)).map((shape) => shape.id);
        props.setSelected([...new Set([...it.base, ...hits])]);
        break;
      }
      case 'erase':
        eraseAt(e);
        break;
      case 'none':
        break;
    }
  }

  function onPointerUp() {
    const it = interaction.current;
    interaction.current = { kind: 'none' };
    switch (it.kind) {
      case 'pan':
        setPanning(false);
        break;
      case 'marquee':
        setMarquee(null);
        break;
      case 'create': {
        const shape = latest()[it.id];
        if (shape?.type === 'line' && Math.hypot(shape.dx, shape.dy) < 4) {
          // 클릭만 한 선은 남기지 않는다.
          history.apply([{ type: 'delete', id: it.id }]);
        } else if ((shape?.type === 'rect' || shape?.type === 'ellipse') && shape.w < 4 && shape.h < 4) {
          // 클릭만 하면 기본 크기로 만든다.
          history.apply([{ type: 'update', id: it.id, patch: { x: round(shape.x - 60), y: round(shape.y - 40), w: 120, h: 80 } }]);
        }
        history.commit();
        if (latest()[it.id]) {
          props.chooseTool('select');
          props.setSelected([it.id]);
        }
        break;
      }
      case 'move':
      case 'resize':
      case 'endpoint':
      case 'pen':
      case 'erase':
        history.commit();
        break;
      case 'none':
        break;
    }
  }

  function onDoubleClick(e: MouseEvent<SVGSVGElement>) {
    if (tool !== 'select') return;
    // 포인터 캡처 때문에 dblclick의 target은 항상 svg다. 실제로 눌린 도형은 좌표로 찾는다.
    const hitId = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-id]')?.getAttribute('data-id');
    const shape = hitId ? latest()[hitId] : undefined;
    if (shape?.type === 'text') editText(shape);
    else if (!shape) newText(toWorld(e));
  }

  const gridSize = 24 * camera.zoom;
  const cursorClass = panning ? 'is-panning' : spaceHeld || tool === 'hand' ? 'is-hand' : `tool-${tool}`;

  return (
    <svg
      ref={svgRef}
      className={`canvas ${cursorClass}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={() => client.setPresence({ cursor: null })}
      onDoubleClick={onDoubleClick}
    >
      <defs>
        <pattern
          id="grid"
          width={gridSize}
          height={gridSize}
          x={-camera.x * camera.zoom}
          y={-camera.y * camera.zoom}
          patternUnits="userSpaceOnUse"
        >
          <circle cx={1} cy={1} r={1} className="grid-dot" />
        </pattern>
      </defs>
      {camera.zoom >= 0.3 && <rect width="100%" height="100%" fill="url(#grid)" pointerEvents="none" />}

      <g transform={`scale(${camera.zoom}) translate(${-camera.x} ${-camera.y})`}>
        <g data-layer="shapes">
          {sorted.map((shape) => (
            <ShapeView key={shape.id} shape={shape} hidden={editing?.id === shape.id} />
          ))}
        </g>
        <PeerSelections shapes={shapes} peers={peers} />
        <SelectionOverlay shapes={shapes} ids={selectedIds} zoom={camera.zoom} interactive={tool === 'select'} />
        {marquee && (
          <rect
            className="marquee"
            x={marquee.minX}
            y={marquee.minY}
            width={marquee.maxX - marquee.minX}
            height={marquee.maxY - marquee.minY}
          />
        )}
      </g>

      <Cursors peers={peers} camera={camera} />
    </svg>
  );
}

function SelectionOverlay({ shapes, ids, zoom, interactive }: { shapes: Shapes; ids: string[]; zoom: number; interactive: boolean }) {
  const selected = ids.map((id) => shapes[id]).filter((shape): shape is Shape => shape !== undefined);
  if (selected.length === 0) return null;
  const pad = 4 / zoom;
  const handle = 10 / zoom;
  const single = selected.length === 1 ? selected[0] : undefined;

  return (
    <g className="selection">
      {selected.map((shape) => {
        if (single?.type === 'line') return null;
        const b = shapeBounds(shape);
        return (
          <rect
            key={shape.id}
            className="selection-outline"
            x={b.minX - pad}
            y={b.minY - pad}
            width={b.maxX - b.minX + pad * 2}
            height={b.maxY - b.minY + pad * 2}
          />
        );
      })}
      {interactive && single?.type === 'line' && (
        <>
          <circle data-handle="start" className="handle handle-point" cx={single.x} cy={single.y} r={handle / 1.6} />
          <circle
            data-handle="end"
            className="handle handle-point"
            cx={single.x + single.dx}
            cy={single.y + single.dy}
            r={handle / 1.6}
          />
        </>
      )}
      {interactive &&
        (single?.type === 'rect' || single?.type === 'ellipse') &&
        (
          [
            ['nw', single.x, single.y],
            ['ne', single.x + single.w, single.y],
            ['sw', single.x, single.y + single.h],
            ['se', single.x + single.w, single.y + single.h],
          ] as const
        ).map(([corner, x, y]) => (
          <rect
            key={corner}
            data-handle={corner}
            className={`handle handle-${corner}`}
            x={x - handle / 2}
            y={y - handle / 2}
            width={handle}
            height={handle}
            rx={2 / zoom}
          />
        ))}
    </g>
  );
}

function PeerSelections({ shapes, peers }: { shapes: Shapes; peers: ReadonlyMap<string, Presence> }) {
  return (
    <g className="peer-selections">
      {[...peers].flatMap(([clientId, presence]) =>
        presence.selection.map((id) => {
          const shape = shapes[id];
          if (!shape) return null;
          const b = shapeBounds(shape);
          return (
            <rect
              key={`${clientId}:${id}`}
              className="peer-selection"
              stroke={presence.user.color}
              x={b.minX - 6}
              y={b.minY - 6}
              width={b.maxX - b.minX + 12}
              height={b.maxY - b.minY + 12}
            />
          );
        }),
      )}
    </g>
  );
}

function Cursors({ peers, camera }: { peers: ReadonlyMap<string, Presence>; camera: Camera }) {
  return (
    <g className="cursors">
      {[...peers].map(([clientId, { user, cursor }]) => {
        if (!cursor) return null;
        const s = worldToScreen(camera, cursor);
        const labelWidth = textSize(user.name, 12).width + 14;
        return (
          <g key={clientId} className="cursor" style={{ transform: `translate(${s.x}px, ${s.y}px)` }}>
            <path d="M0 0L0 17L4.6 12.7L8 20L10.8 18.8L7.5 11.6L13.6 11.6Z" fill={user.color} stroke="#fff" strokeWidth={1.5} />
            <g transform="translate(14 18)">
              <rect width={labelWidth} height={20} rx={6} fill={user.color} />
              <text x={7} y={14} fontSize={12} fill="#fff">
                {user.name}
              </text>
            </g>
          </g>
        );
      })}
    </g>
  );
}

function squareCorner(fixed: Point, p: Point): Point {
  const size = Math.max(Math.abs(p.x - fixed.x), Math.abs(p.y - fixed.y));
  return { x: fixed.x + Math.sign(p.x - fixed.x || 1) * size, y: fixed.y + Math.sign(p.y - fixed.y || 1) * size };
}

// Shift를 누르면 45도 단위로 맞춘다.
function snapAngle(start: Point, p: Point): Point {
  const angle = Math.round(Math.atan2(p.y - start.y, p.x - start.x) / (Math.PI / 4)) * (Math.PI / 4);
  const length = Math.hypot(p.x - start.x, p.y - start.y);
  return { x: start.x + Math.cos(angle) * length, y: start.y + Math.sin(angle) * length };
}

export function isEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
  );
}
