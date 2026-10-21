import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from './app.ts';

let server: RunningServer;
let dataDir: string;
let staticDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'whiteboard-app-'));
  staticDir = path.join(dataDir, 'public');
  await mkdir(staticDir);
  await writeFile(path.join(staticDir, 'index.html'), '<!doctype html><title>app</title>');
  server = await startServer({ port: 0, dataDir: path.join(dataDir, 'rooms'), staticDir });
});

afterEach(async () => {
  await server.close();
  await rm(dataDir, { recursive: true, force: true });
});

// 서버가 소켓을 닫을 때의 종료 코드를 기다린다.
function closeCodeAfter(messages: unknown[]): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${server.port}/ws`);
    ws.onopen = () => {
      for (const message of messages) ws.send(typeof message === 'string' ? message : JSON.stringify(message));
    };
    ws.onclose = (event) => resolve(event.code);
  });
}

function rawGet(requestPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: 'localhost', port: server.port, path: requestPath }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      })
      .on('error', reject);
  });
}

const hello = (roomId: string) => ({
  type: 'hello',
  roomId,
  clientId: 'clientAAAA',
  lastSeq: null,
  user: { name: 'tester', color: '#123456' },
});

describe('server', () => {
  it('스키마에 맞지 않는 메시지를 보내면 연결을 끊는다', async () => {
    expect(await closeCodeAfter(['not json'])).toBe(1007);
    expect(await closeCodeAfter([{ type: 'hello', roomId: '../../etc' }])).toBe(1008);
  });

  it('저장 파일이 깨진 방에 들어오면 그 연결만 닫고 서버는 계속 동작한다', async () => {
    await mkdir(path.join(dataDir, 'rooms'), { recursive: true });
    await writeFile(path.join(dataDir, 'rooms', 'brokenRoom.json'), '{ not valid');
    expect(await closeCodeAfter([hello('brokenRoom')])).toBe(1011);
    expect(await rawGet('/healthz')).toBe(200);
  });

  it('메시지 크기 제한을 넘으면 그 연결만 닫고(1009) 서버는 계속 동작한다', async () => {
    expect(await closeCodeAfter(['x'.repeat(2 * 1024 * 1024)])).toBe(1009);
    expect(await rawGet('/healthz')).toBe(200);
  });

  it('정적 파일 경로로 상위 폴더에 접근할 수 없다', async () => {
    expect(await rawGet('/..%2f..%2fpackage.json')).toBe(403);
  });

  it('확장자 없는 경로는 index.html로 보낸다 (SPA)', async () => {
    expect(await rawGet('/r/someBoard1')).toBe(200);
    expect(await rawGet('/missing.js')).toBe(404);
  });
});
