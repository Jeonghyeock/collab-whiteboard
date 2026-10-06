export type Tool = 'select' | 'hand' | 'pen' | 'rect' | 'ellipse' | 'line' | 'arrow' | 'text' | 'eraser';

export type Size = 's' | 'm' | 'l';

export type Style = { stroke: string; size: Size; filled: boolean };

// 화면 좌표 = (월드 좌표 - (x, y)) * zoom
export type Camera = { x: number; y: number; zoom: number };

// id가 null이면 새로 만드는 중인 텍스트다.
export type TextEditing = { id: string | null; x: number; y: number; text: string; fontSize: number; color: string };
