import type { Shapes } from '../../../shared/protocol.ts';
import { shapeBounds, unionBounds } from './geometry.ts';

const PADDING = 32;
const MAX_CANVAS_SIDE = 8192;

// 화면의 도형 레이어를 복제해 그림 전체가 들어가는 SVG를 만들고, canvas에 그려 PNG로 저장한다.
export async function exportPng(svg: SVGSVGElement, shapes: Shapes, fileName: string): Promise<boolean> {
  const bounds = unionBounds(Object.values(shapes).map(shapeBounds));
  const layer = svg.querySelector('[data-layer="shapes"]');
  if (!bounds || !layer) return false;

  const x = bounds.minX - PADDING;
  const y = bounds.minY - PADDING;
  const width = bounds.maxX - bounds.minX + PADDING * 2;
  const height = bounds.maxY - bounds.minY + PADDING * 2;

  const clone = layer.cloneNode(true) as Element;
  for (const hit of clone.querySelectorAll('.hit')) hit.remove();
  const markup =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${x} ${y} ${width} ${height}">` +
    `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="#ffffff"/>` +
    new XMLSerializer().serializeToString(clone) +
    `</svg>`;

  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  await image.decode();

  const scale = Math.min(2, MAX_CANVAS_SIDE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) return false;

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}
