import { useSyncExternalStore } from 'react';

// 화면이 둘(홈, 보드)뿐이라 라우터 라이브러리 없이 History API만 쓴다.

// 앱 안에서 다른 화면으로 가기 전에 물어볼 것(보드에 아직 보내지 못한 변경 등). false 면 이동하지 않는다.
// 앱 안 이동은 페이지를 떠나지 않아 beforeunload 확인이 뜨지 않으므로 여기서 따로 묻는다.
let leaveGuard: (() => boolean) | null = null;

// 기록 항목마다 번호(idx)를 history.state 에 둔다. 브라우저 뒤로·앞으로를 거절할 때 몇 칸 움직였는지 알아
// history.go 로 원래 항목에 되돌아가기 위해서다(새 항목을 쌓으면 기록이 겹치거나 앞쪽이 잘린다).
let currentPath = window.location.pathname;
let currentIdx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
window.history.replaceState({ ...(window.history.state ?? {}), idx: currentIdx }, '');

export function setLeaveGuard(guard: () => boolean): () => void {
  leaveGuard = guard;
  return () => {
    if (leaveGuard === guard) leaveGuard = null;
  };
}

export function navigate(path: string): void {
  if (path !== currentPath && leaveGuard && !leaveGuard()) return;
  currentIdx += 1;
  window.history.pushState({ idx: currentIdx }, '', path);
  currentPath = window.location.pathname; // 브라우저가 정규화한 값으로 비교한다
  window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
}

// 브라우저의 뒤로·앞으로는 주소가 이미 바뀐 뒤에 알려 온다. 머물기로 하면 history.go 로 원래 항목에 돌아가고,
// 화면이 바뀌지 않게 이 이벤트를 다른 리스너(usePathname)에 전하지 않는다. 되돌아갈 때 오는 popstate 는 주소가
// 그대로라 아래 첫 줄에서 걸러진다. 모듈을 불러올 때 등록해 React 가 다는 리스너보다 먼저 불린다.
window.addEventListener('popstate', (event) => {
  const path = window.location.pathname;
  const idx = (event.state as { idx?: number } | null)?.idx ?? currentIdx;
  if (path === currentPath) {
    currentIdx = idx;
    return; // navigate 가 보낸 이벤트이거나 되돌아온 것
  }
  if (leaveGuard && !leaveGuard()) {
    window.history.go(currentIdx - idx);
    event.stopImmediatePropagation();
    return;
  }
  currentPath = path;
  currentIdx = idx;
});

function subscribe(listener: () => void) {
  window.addEventListener('popstate', listener);
  return () => window.removeEventListener('popstate', listener);
}

export function usePathname(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname);
}
