import { test, expect, gotoApp } from './helpers.js';

test.beforeEach(async ({ page }) => { await gotoApp(page); });

test('page title', async ({ page }) => {
  await expect(page).toHaveTitle('Pianizer');
});

test('status bar shows load prompt when nothing is loaded', async ({ page }) => {
  await expect(page.locator('#status')).toContainText('Load MusicXML or a project file');
});

test('help overlay opens with ?', async ({ page }) => {
  await page.keyboard.press('?');
  await expect(page.locator('.help-overlay')).toBeVisible();
  await expect(page.locator('.help-overlay')).toContainText('Keyboard & mouse shortcuts');
});

test('help overlay closes with Escape', async ({ page }) => {
  await page.keyboard.press('?');
  await page.keyboard.press('Escape');
  await expect(page.locator('.help-overlay')).not.toBeVisible();
});

test('help overlay closes by clicking outside', async ({ page }) => {
  await page.keyboard.press('?');
  await page.mouse.click(10, 10);
  await expect(page.locator('.help-overlay')).not.toBeVisible();
});
