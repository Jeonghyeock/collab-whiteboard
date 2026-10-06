import type { Point, Shape, Shapes } from '../../../shared/protocol.ts';
import type { Camera } from './types.ts';

export type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

export const FONT_FAMILY =
  "Pretendard, -apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', 'Malgun Gothic', 'Segoe UI', sans-serif";
export const LINE_HEIGHT = 1.25;

let measureContext: CanvasRenderingContext2D | null = null;

export function textSize(text: string, fontSize: number): { width: number; height: number } {
  measureContext ??= document.createElement('canvas').getContext('2d');
  const lines = text.split('\n');
  let width = 0;
  if (measureContext) {
    measureContext.font = `${fontSize}px ${FONT_FAMILY}`;
    for (const line of lines) width = Math.max(width, measureContext.measureText(line).width);
  }
  return { width: Math.max(width, fontSize * 0.5), height: lines.length * fontSize * LINE_HEIGHT };
}

export function shapeBounds(shape: Shape): Bounds {
  const { x, y } = shape;
  switch (shape.type) {
    case 'rect':
    case 'ellipse':
      return { minX: x, minY: y, maxX: x + shape.w, maxY: y + shape.h };
    case 'line':
      return {
        minX: Math.min(x, x + shape.dx),
        minY: Math.min(y, y + shape.dy),
        maxX: Math.max(x, x + shape.dx),
        maxY: Math.max(y, y + shape.dy),
      };
    case 'pen': {
      let minX = 0, minY = 0, maxX = 0, maxY = 0;
      for (let i = 0; i < shape.points.length; i += 2) {
        const px = shape.points[i]!;
        const py = shape.points[i + 1]!;
        minX = Math.min(minX, px);
        minY = Math.min(minY, py);
        maxX = Math.max(maxX, px);
        maxY = Math.max(maxY, py);
      }
      return { minX: x + minX, minY: y + minY, maxX: x + maxX, maxY: y + maxY };
    }
    case 'text': {
      const size = textSize(shape.text, shape.fontSize);
      return { minX: x, minY: y, maxX: x + size.width, maxY: y + size.height };
    }
  }
}

export function unionBounds(list: Bounds[]): Bounds | null {
  if (list.length === 0) return null;
  return list.reduce((a, b) => ({
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  }));
}

export function intersects(a: Bounds, b: Bounds): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

export function boundsFromPoints(a: Point, b: Point): Bounds {
  return { minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) };
}

// 쌓임 순서: z가 같으면(동시에 만든 경우) id로 정해 모든 클라이언트에서 같은 순서가 되게 한다.
export function sortShapes(shapes: Shapes): Shape[] {
  return Object.values(shapes).sort((a, b) => a.z - b.z || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function topZ(shapes: Shapes): number {
  let max = 0;
  for (const shape of Object.values(shapes)) max = Math.max(max, shape.z);
  return max + 1;
}

// 펜 획을 부드럽게: 점과 점 사이의 중점을 지나는 2차 베지어 곡선으로 잇는다.
export function penPath(points: readonly number[]): string {
  if (points.length < 2) return '';
  const n = points.length / 2;
  const px = (i: number) => points[i * 2]!;
  const py = (i: number) => points[i * 2 + 1]!;
  if (n === 1) return `M${px(0)} ${py(0)}L${px(0)} ${py(0)}`;
  let d = `M${px(0)} ${py(0)}`;
  for (let i = 1; i < n - 1; i++) {
    d += `Q${px(i)} ${py(i)} ${(px(i) + px(i + 1)) / 2} ${(py(i) + py(i + 1)) / 2}`;
  }
  return d + `L${px(n - 1)} ${py(n - 1)}`;
}

export function screenToWorld(camera: Camera, screen: Point): Point {
  return { x: screen.x / camera.zoom + camera.x, y: screen.y / camera.zoom + camera.y };
}

export function worldToScreen(camera: Camera, world: Point): Point {
  return { x: (world.x - camera.x) * camera.zoom, y: (world.y - camera.y) * camera.zoom };
}

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 5;

// 화면의 한 점(anchor)이 가리키는 월드 좌표를 유지한 채 확대/축소한다.
export function zoomAt(camera: Camera, nextZoom: number, anchor: Point): Camera {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom));
  const world = screenToWorld(camera, anchor);
  return { zoom, x: world.x - anchor.x / zoom, y: world.y - anchor.y / zoom };
}

export function fitBounds(bounds: Bounds, viewport: { width: number; height: number }, padding = 80): Camera {
  const width = Math.max(bounds.maxX - bounds.minX, 1);
  const height = Math.max(bounds.maxY - bounds.minY, 1);
  const zoom = Math.min(
    MAX_ZOOM,
    Math.max(MIN_ZOOM, Math.min((viewport.width - padding * 2) / width, (viewport.height - padding * 2) / height, 1)),
  );
  return {
    zoom,
    x: bounds.minX + width / 2 - viewport.width / 2 / zoom,
    y: bounds.minY + height / 2 - viewport.height / 2 / zoom,
  };
}
