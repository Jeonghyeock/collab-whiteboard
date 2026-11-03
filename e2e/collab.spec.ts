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

test('보내지 못한 변경이 있으면 앱 안에서 보드를 떠나기 전에 확인한다', async ({ browser }) => {
  // 고치기 전에는 로고·뒤로 가기가 pushState 이동이라 확인 없이 보드를 닫으며 대기 중인 변경을 버렸다
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto('/');
    await page.getByRole('button', { name: '새 보드 만들기' }).click();
    await expect(page.locator('.status-online')).toBeVisible();
    const boardUrl = page.url();

    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await expect(page.locator('.status-offline')).toBeVisible();
    await page.keyboard.press('r');
    await drag(page, [300, 300], [450, 400]);
    await expect(page.locator('.status-pending')).toContainText('전송 대기 1');

    let answer = false;
    const asked: string[] = [];
    page.on('dialog', async (dialog) => {
      asked.push(dialog.message());
      await (answer ? dialog.accept() : dialog.dismiss());
    });

    const historyLength = await page.evaluate(() => history.length);
    await page.goBack(); // 브라우저 뒤로 가기 → 머문다
    await expect(page).toHaveURL(boardUrl);
    // 머물 때 새 항목을 쌓지 않고 원래 항목으로 돌아온다(기록이 겹치거나 앞쪽이 잘리지 않음)
    expect(await page.evaluate(() => history.length)).toBe(historyLength);
    await page.locator('.brand').click(); // 로고 → 머문다
    await expect(page).toHaveURL(boardUrl);
    await expect(shapes(page)).toHaveCount(1);
    await expect(page.locator('.status-pending')).toContainText('전송 대기 1');
    expect(asked).toHaveLength(2);

    answer = true;
    await page.locator('.brand').click(); // 이번에는 떠난다
    await expect(page.getByRole('button', { name: '새 보드 만들기' })).toBeVisible();
    expect(asked).toHaveLength(3);
  } finally {
    await context.close();
  }
});
