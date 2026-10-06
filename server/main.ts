import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer } from './app.ts';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const distDir = fileURLToPath(new URL('../dist', import.meta.url));

const server = await startServer({
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST,
  dataDir: process.env.DATA_DIR ?? `${projectRoot}data`,
  staticDir: existsSync(distDir) ? distDir : undefined,
});

console.log(`[server] http://localhost:${server.port}${existsSync(distDir) ? '' : ' (WebSocket only — run `npm run build` to serve the app)'}`);

// 종료 신호를 받으면 접속을 닫고 아직 저장하지 않은 변경을 파일에 쓴 뒤 끝낸다.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await server.close();
    process.exit(0);
  });
}
