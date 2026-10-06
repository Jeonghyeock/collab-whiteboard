import { expect, test, type Browser, type Page } from '@playwright/test';

// 브라우저 컨텍스트 두 개 = 서로 다른 두 사용자

async function openBoard(browser: Browser, roomId: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`/r/${roomId}`);
  await expect(page.locator('.status-online')).toBeVisible();
  return { context, page };
}

async function drag(page: Page, from: [number, number], to: [number, number]) {
  await page.mouse.move(...from);
  await page.mouse.down();
  await page.mouse.move(...to, { steps: 10 });
  await page.mouse.up();
}

const shapes = (page: Page) => page.locator('[data-layer="shapes"] [data-id]');
const rectStroke = (page: Page) => page.locator('[data-layer="shapes"] rect[rx="4"]').first();
const roomId = () => `e2e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

test('한 사람이 그린 도형과 커서가 다른 사람에게 보인다', async ({ browser }) => {
  const room = roomId();
  const a = await openBoard(browser, room);
  const b = await openBoard(browser, room);

  await a.page.keyboard.press('r');
  await drag(a.page, [300, 300], [500, 420]);
  await a.page.mouse.move(700, 500);

  await expect(shapes(b.page)).toHaveCount(1);
  await expect(b.page.locator('.cursor')).toHaveCount(1);
  await expect(b.page.locator('.avatar')).toHaveCount(2); // 상대 + 나
});

test('오프라인에서 그린 도형은 다시 연결되면 상대에게 전달된다', async ({ browser }) => {
  const room = roomId();
  const a = await openBoard(browser, room);
  const b = await openBoard(browser, room);

  await a.context.setOffline(true);
  await a.page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(a.page.locator('.status-offline')).toBeVisible();

  await a.page.keyboard.press('o');
  await drag(a.page, [300, 300], [450, 400]);
  await expect(a.page.locator('.status-pending')).toContainText('전송 대기 1');
  await expect(shapes(b.page)).toHaveCount(0);

  await a.context.setOffline(false);
  await a.page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(a.page.locator('.status-online')).toBeVisible();
  await expect(shapes(b.page)).toHaveCount(1);
});

test('실행 취소는 내 변경만 되돌리고 다른 사람의 변경은 남긴다', async ({ browser }) => {
  const room = roomId();
  const a = await openBoard(browser, room);
  const b = await openBoard(browser, room);

  await a.page.keyboard.press('r');
  await drag(a.page, [300, 300], [500, 420]); // 그린 뒤 자동으로 선택된다
  await expect(shapes(b.page)).toHaveCount(1);

  // A가 굵기를 바꾸고, B가 색을 바꾼다.
  await a.page.getByRole('button', { name: '굵게' }).click();
  await expect(rectStroke(b.page)).toHaveAttribute('stroke-width', '8');
  await b.page.mouse.click(300, 360);
  await b.page.getByRole('button', { name: '색 #1971c2' }).click();
  await expect(rectStroke(a.page)).toHaveAttribute('stroke', '#1971c2');

  // A의 실행 취소: 굵기만 돌아가고 B가 바꾼 색은 그대로
  await a.page.mouse.click(900, 600);
  await a.page.keyboard.press('Control+z');
  await expect(rectStroke(b.page)).toHaveAttribute('stroke-width', '4');
  await expect(rectStroke(b.page)).toHaveAttribute('stroke', '#1971c2');
});

test('텍스트를 쓰고 더블클릭으로 고칠 수 있다', async ({ browser }) => {
  const room = roomId();
  const a = await openBoard(browser, room);
  const b = await openBoard(browser, room);

  await a.page.keyboard.press('t');
  await a.page.mouse.click(400, 300);
  await expect(a.page.locator('.text-editor')).toBeFocused();
  await a.page.keyboard.type('회의 안건');
  await a.page.keyboard.press('Escape');
  await expect(b.page.locator('[data-layer="shapes"] text')).toHaveText('회의 안건');

  await a.page.mouse.dblclick(420, 300);
  await expect(a.page.locator('.text-editor')).toBeFocused();
  await a.page.keyboard.type(' 정리');
  await a.page.keyboard.press('Escape');
  await expect(b.page.locator('[data-layer="shapes"] text')).toHaveText('회의 안건 정리');
});

test('새로고침해도 보드가 그대로 남아 있다', async ({ browser }) => {
  const room = roomId();
  const a = await openBoard(browser, room);
  await a.page.keyboard.press('p');
  await drag(a.page, [300, 300], [500, 350]);
  await expect(a.page.locator('.status-online')).toBeVisible();
  await expect.poll(() => a.page.evaluate(() => document.querySelector('.status-pending'))).toBeNull();

  await a.page.reload();
  await expect(a.page.locator('.status-online')).toBeVisible();
  await expect(shapes(a.page)).toHaveCount(1);
});
