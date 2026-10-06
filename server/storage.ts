import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RoomSnapshot } from './room.ts';

// 방 하나 = JSON 파일 하나. roomId는 스키마에서 영숫자만 허용하므로 경로로 그대로 써도 안전하다.
const fileOf = (dataDir: string, roomId: string) => path.join(dataDir, `${roomId}.json`);

export async function loadRoom(dataDir: string, roomId: string): Promise<RoomSnapshot | undefined> {
  try {
    return JSON.parse(await readFile(fileOf(dataDir, roomId), 'utf8')) as RoomSnapshot;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

// 임시 파일에 쓴 뒤 rename한다. 쓰는 도중 프로세스가 죽어도 기존 파일이 깨지지 않는다.
export async function saveRoom(dataDir: string, roomId: string, snapshot: RoomSnapshot): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const file = fileOf(dataDir, roomId);
  await writeFile(`${file}.tmp`, JSON.stringify(snapshot));
  await rename(`${file}.tmp`, file);
}
