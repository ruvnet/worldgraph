import { expect, test } from '@playwright/test';

test('streams a real snapshot and visible deltas through WASM', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('#connection-pill')).toHaveText('LIVE');
  await expect(page.locator('#transport')).toHaveText('websocket');
  await expect(page.locator('#epoch')).not.toHaveText('—');
  await expect(page.locator('#nodes')).not.toHaveText('0');
  const first = Number(await page.locator('#sequence').textContent());
  const canvas = page.locator('#world');
  const before = await canvas.screenshot();
  await expect.poll(async () => Number(await page.locator('#sequence').textContent())).toBeGreaterThan(first);
  await expect.poll(async () => (await canvas.screenshot()).equals(before)).toBe(false);
  await expect(page.locator('#presence')).not.toHaveText('0');
  expect(errors).toEqual([]);
  await page.screenshot({ path: 'test-results/live-demo.png', fullPage: true });
});
