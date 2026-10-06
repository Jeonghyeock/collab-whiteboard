import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

// 빌드된 클라이언트(dist/)를 제공한다. 확장자 없는 경로(/r/abc 등)는 index.html로 보낸다(SPA).
export function createStaticHandler(root: string) {
  const rootDir = path.resolve(root);

  async function sendFile(res: ServerResponse, file: string, head: boolean) {
    const isHashedAsset = file.startsWith(path.join(rootDir, 'assets') + path.sep);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': isHashedAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    if (head) res.end();
    else createReadStream(file).on('error', () => res.destroy()).pipe(res);
  }

  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const file = path.resolve(rootDir, '.' + pathname);
    if (file !== rootDir && !file.startsWith(rootDir + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    const head = req.method === 'HEAD';
    const info = await stat(file).catch(() => null);
    if (info?.isFile()) return sendFile(res, file, head);
    if (!path.extname(pathname)) return sendFile(res, path.join(rootDir, 'index.html'), head);
    res.writeHead(404).end();
  };
}
