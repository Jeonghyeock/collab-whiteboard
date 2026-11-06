import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { startServer } from './app.ts';

// 저장을 멈춰 둘 수 있게 한다(느린 디스크 흉내). hold 가 없으면 그대로 저장한다.
const ctl = vi.hoisted(() => ({ hold: null as Promise<void> | null }));
vi.mock('./storage.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('./storage.ts')>();
  return {
    ...original,
    saveRoom: async (...args: Parameters<typeof original.saveRoom>) => {
      if (ctl.hold) await ctl.hold;
      return original.saveRoom(...args);
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
  const dataDir = await mkdtemp(path.join(tmpdir(), 'whiteboard-unload-'));
  const s = await startServer({ port: 0, dataDir, saveDelayMs: 10, idleUnloadMs: 300 });
  let release = () => {};
  try {
    ctl.hold = new Promise<void>((resolve) => (release = resolve));
    const a = await join(s.port, 'raceRoom01', 'secretAAAAAAAAAAAAAA');
    a.ws.send(JSON.stringify({ type: 'mutate', clientSeq: 1, ops: [{ type: 'add', shape: rect('shape0001') }] }));
    await vi.waitFor(() => expect(a.messages.some((m) => m.type === 'commit')).toBe(true));
    await sleep(50); // 저장이 시작돼 멈춰 있다
    a.ws.close();
    await sleep(500); // T1 이 돌아 저장을 기다리고 있다

    const b = await join(s.port, 'raceRoom01', 'secretBBBBBBBBBBBBBB'); // 아직 처음 방
    b.ws.close(); // T2 가 300ms 뒤로 걸린다
    await sleep(20);
    ctl.hold = null;
    release(); // 저장이 끝나면 T1 이 처음 방을 내린다
    await vi.waitFor(() => access(path.join(dataDir, 'raceRoom01.json')));
    await sleep(20);

    const c = await join(s.port, 'raceRoom01', 'secretCCCCCCCCCCCCCC'); // 새 인스턴스를 올린다
    await sleep(500); // T2 가 돈다
    const d = await join(s.port, 'raceRoom01', 'secretDDDDDDDDDDDDDD');

    expect(epochOf(c)).not.toBe(epochOf(b)); // 처음 방은 내려갔다
    expect(epochOf(d)).toBe(epochOf(c));
    c.ws.send(JSON.stringify({ type: 'mutate', clientSeq: 1, ops: [{ type: 'add', shape: rect('shape0002') }] }));
    await vi.waitFor(() => expect(d.messages.some((m) => m.type === 'commit')).toBe(true));
    c.ws.close();
    d.ws.close();
  } finally {
    ctl.hold = null;
    release();
    await s.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
