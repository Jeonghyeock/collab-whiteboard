import type { User } from '../../../shared/protocol.ts';

// localStorage는 사생활 보호 모드 등에서 예외를 던질 수 있다. 실패해도 앱은 동작해야 한다.
function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 저장하지 못해도 현재 세션에서는 문제없다.
  }
}

const ADJECTIVES = ['용감한', '졸린', '배고픈', '신나는', '차분한', '수줍은', '똑똑한', '느긋한', '부지런한', '엉뚱한'];
const ANIMALS = ['수달', '고양이', '펭귄', '여우', '판다', '다람쥐', '고래', '부엉이', '해달', '토끼'];
export const USER_COLORS = ['#e03131', '#f76707', '#2f9e44', '#1c7ed6', '#7048e8', '#d6336c', '#0c8599', '#e8590c'];

const pick = <T,>(list: readonly T[]) => list[Math.floor(Math.random() * list.length)]!;

export function loadUser(): User {
  const saved = read<User>('whiteboard:user');
  if (saved?.name && saved.color) return saved;
  const user = { name: `${pick(ADJECTIVES)} ${pick(ANIMALS)}`, color: pick(USER_COLORS) };
  write('whiteboard:user', user);
  return user;
}

export function saveUser(user: User): void {
  write('whiteboard:user', user);
}

export type RecentBoard = { id: string; visitedAt: number };

export function recentBoards(): RecentBoard[] {
  return read<RecentBoard[]>('whiteboard:recent') ?? [];
}

export function rememberBoard(id: string): void {
  const list = recentBoards().filter((board) => board.id !== id);
  write('whiteboard:recent', [{ id, visitedAt: Date.now() }, ...list].slice(0, 8));
}

export function forgetBoard(id: string): void {
  write(
    'whiteboard:recent',
    recentBoards().filter((board) => board.id !== id),
  );
}
