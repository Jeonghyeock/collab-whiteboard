import { useSyncExternalStore } from 'react';

// 화면이 둘(홈, 보드)뿐이라 라우터 라이브러리 없이 History API만 쓴다.
export function navigate(path: string): void {
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function subscribe(listener: () => void) {
  window.addEventListener('popstate', listener);
  return () => window.removeEventListener('popstate', listener);
}

export function usePathname(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname);
}
