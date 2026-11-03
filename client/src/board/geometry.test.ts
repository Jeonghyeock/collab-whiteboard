import { describe, expect, it } from 'vitest';
import { LIMITS } from '../../../shared/limits.ts';
import { clampCamera, screenToWorld } from './geometry.ts';

describe('clampCamera', () => {
  const view = { width: 1200, height: 800 };

  it('보는 영역이 좌표 범위를 벗어나지 않게 카메라를 막는다', () => {
    for (const zoom of [0.1, 1, 5]) {
      const camera = clampCamera({ x: 5e6, y: -5e6, zoom }, view);
      const topLeft = screenToWorld(camera, { x: 0, y: 0 });
      const bottomRight = screenToWorld(camera, { x: view.width, y: view.height });
      expect(topLeft.y).toBeGreaterThanOrEqual(-LIMITS.maxCoord);
      expect(bottomRight.x).toBeLessThanOrEqual(LIMITS.maxCoord + 1e-6);
    }
  });

  it('범위 안의 카메라는 그대로 둔다', () => {
    expect(clampCamera({ x: -600, y: 100, zoom: 1 }, view)).toEqual({ x: -600, y: 100, zoom: 1 });
  });
});
