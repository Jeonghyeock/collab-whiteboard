import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { startServer } from './app.ts';
import { Room } from './room.ts';

// 저장을 멈춰 둘 수 있게 한다(느린 디스크 흉내). hold 가 없으면 그대로 저장한다. 시작한 저장과 끝난 저장을 센다.
const ctl = vi.hoisted(() => ({ hold: null as Promise<void> | null, started: 0, finished: 0 }));
vi.mock('./storage.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('./storage.ts')>();
  return {
    ...original,
    saveRoom: async (...args: Parameters<typeof original.saveRoom>) => {
      ctl.started += 1;
      if (ctl.hold) await ctl.hold;
      await original.saveRoom(...args);
      ctl.finished += 1;
    },
  };
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Client = { ws: WebSocket; messages: { type: string; epoch?: string }[] };
async function join(port: number, roomId: string, clientSecret: string): Promise<Client> {
  const ws = new WebSocket(`ws://localhost:${port}/ws`);
  const messages: Client['messages'] = [];
  ws.onmessage = (event) => messages.push(JSON.parse(String(event.data)));
  await new Promise<void>((resolve) => (ws.onopen = () => resolve()));
  ws.send(JSON.stringify({ type: 'hello', roomId, clientSecret, lastSeq: null, user: { name: 'tester', color: '#123456' } }));
  await vi.waitFor(() => expect(messages.some((m) => m.type === 'welcome')).toBe(true));
  return { ws, messages };
}
const epochOf = (client: Client) => client.messages.find((m) => m.type === 'welcome')?.epoch;
const rect = (id: string) => ({ id, type: 'rect', x: 0, y: 0, z: 0, stroke: '#000000', strokeWidth: 2, w: 10, h: 10, fill: null });

it('늦게 도는 내리기 타이머가 같은 id 로 새로 올라온 방을 지우지 않는다', async () => {
  // 내리기 타이머 T1 이 저장을 기다리는 사이 B 가 들어왔다 나가면 두 번째 타이머 T2 가 걸린다. T1 이 방을 내린 뒤
  // C 가 들어와 새 인스턴스가 올라오면, 고치기 전에는 T2 가 그 새 방까지 지웠다. 그 뒤 들어온 D 는 또 다른 인스턴스를 받아
  // 같은 방이 둘로 갈라졌다(서로의 변경을 받지 못하고, 같은 파일에 번갈아 저장해 서로 덮어씀).
  const idleUnloadMs = 1500;
  const dataDir = await mkdtemp(path.join(tmpdir(), 'whiteboard-unload-'));
  // 저장 지연을 길게 두어 저장은 T1 이 시작하게 한다. 그래서 '저장 시작'이 곧 'T1 이 돌아 저장을 기다린다'는 신호다.
  const s = await startServer({ port: 0, dataDir, saveDelayMs: 60_000, idleUnloadMs });
  const leave = vi.spyOn(Room.prototype, 'leave'); // 서버가 퇴장을 처리했다는 신호(바로 뒤에 내리기를 예약한다)
  let release = () => {};
  try {
    ctl.hold = new Promise<void>((resolve) => (release = resolve));
    const a = await join(s.port, 'raceRoom01', 'secretAAAAAAAAAAAAAA');
    a.ws.send(JSON.stringify({ type: 'mutate', clientSeq: 1, ops: [{ type: 'add', shape: rect('shape0001') }] }));
    await vi.waitFor(() => expect(a.messages.some((m) => m.type === 'commit')).toBe(true));
    a.ws.close();
    await vi.waitFor(() => expect(ctl.started).toBe(1), { timeout: idleUnloadMs + 5000 }); // T1 이 저장을 기다린다

    const b = await join(s.port, 'raceRoom01', 'secretBBBBBBBBBBBBBB'); // 아직 처음 방
    const bClosedAt = Date.now();
    b.ws.close();
    await vi.waitFor(() => expect(leave).toHaveBeenCalledTimes(2)); // 서버가 B 의 퇴장을 처리해 T2 가 걸렸다
    const t2DueBy = Date.now() + idleUnloadMs;
    ctl.hold = null;
    release();
    await vi.waitFor(() => expect(ctl.finished).toBe(1), { timeout: 5000 }); // 저장이 끝나 T1 이 처음 방을 내렸다

    const c = await join(s.port, 'raceRoom01', 'secretCCCCCCCCCCCCCC'); // 새 인스턴스를 올린다
    // 경쟁이 실제로 만들어졌는지 확인한다: 처음 방은 T1 이 내렸고, C 의 방은 T2 가 돌기 전에 올라왔다.
    // 둘 중 하나라도 아니면 이 테스트는 고치기 전 코드에서도 통과할 수 있으므로 실패로 알린다.
    expect(epochOf(c)).not.toBe(epochOf(b));
    expect(Date.now() - bClosedAt).toBeLessThan(idleUnloadMs - 100);
    await sleep(t2DueBy - Date.now() + 500); // T2 가 돈다

    const d = await join(s.port, 'raceRoom01', 'secretDDDDDDDDDDDDDD');
    expect(epochOf(d)).toBe(epochOf(c));
    c.ws.send(JSON.stringify({ type: 'mutate', clientSeq: 1, ops: [{ type: 'add', shape: rect('shape0002') }] }));
    await vi.waitFor(() => expect(d.messages.some((m) => m.type === 'commit')).toBe(true));
    c.ws.close();
    d.ws.close();
  } finally {
    leave.mockRestore();
    ctl.hold = null;
    release();
    await s.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}, 20_000);
