import { test, expect, gotoApp, loadProject, notePagePos } from './helpers.js';

test.beforeEach(async ({ page }) => {
  await gotoApp(page);
  await loadProject(page);
});

// ── load ─────────────────────────────────────────────────────────────────────

test('status bar shows note count after load', async ({ page }) => {
  await expect(page.locator('#status')).toContainText('3 notes');
});

test('state holds the correct number of notes', async ({ page }) => {
  const count = await page.evaluate(() => window._state.notes.length);
  expect(count).toBe(3);
});

// ── selection ─────────────────────────────────────────────────────────────────

test('click note selects it', async ({ page }) => {
  const pos = await notePagePos(page, 0);
  await page.mouse.click(pos.x, pos.y);
  const sel = await page.evaluate(() => window._state.selectedNoteIndices.size);
  expect(sel).toBe(1);
});

test('click sole-selected note deselects it', async ({ page }) => {
  const pos = await notePagePos(page, 0);
  await page.mouse.click(pos.x, pos.y);
  await page.mouse.click(pos.x, pos.y);
  const sel = await page.evaluate(() => window._state.selectedNoteIndices.size);
  expect(sel).toBe(0);
});

test('shift-click extends selection', async ({ page }) => {
  const p0 = await notePagePos(page, 0);
  const p1 = await notePagePos(page, 1);
  await page.mouse.click(p0.x, p0.y);
  await page.keyboard.down('Shift');
  await page.mouse.click(p1.x, p1.y);
  await page.keyboard.up('Shift');
  const sel = await page.evaluate(() => window._state.selectedNoteIndices.size);
  expect(sel).toBe(2);
});

test('Escape clears selection', async ({ page }) => {
  const pos = await notePagePos(page, 0);
  await page.mouse.click(pos.x, pos.y);
  await page.keyboard.press('Escape');
  const sel = await page.evaluate(() => window._state.selectedNoteIndices.size);
  expect(sel).toBe(0);
});

// ── editing ───────────────────────────────────────────────────────────────────

test('Delete removes selected note', async ({ page }) => {
  const pos = await notePagePos(page, 0);
  await page.mouse.click(pos.x, pos.y);
  await page.keyboard.press('Delete');
  const count = await page.evaluate(() => window._state.notes.length);
  expect(count).toBe(2);
});

test('Ctrl+Z undoes deletion', async ({ page }) => {
  const pos = await notePagePos(page, 0);
  await page.mouse.click(pos.x, pos.y);
  await page.keyboard.press('Delete');
  await page.keyboard.press('Control+z');
  const count = await page.evaluate(() => window._state.notes.length);
  expect(count).toBe(3);
});

// ── tool windows ─────────────────────────────────────────────────────────────

test('[1] velocity tool sets velocity', async ({ page }) => {
  const pos = await notePagePos(page, 0);
  await page.mouse.click(pos.x, pos.y);
  await page.keyboard.press('1');
  await expect(page.locator('.tool-window')).toBeVisible();
  await page.locator('.velocity-grid button', { hasText: '80' }).click();
  const vel = await page.evaluate(() => window._state.notes[0].velocity);
  expect(vel).toBe(80);
});

test('[1] velocity tool does not open with no selection', async ({ page }) => {
  await page.keyboard.press('1');
  await expect(page.locator('.tool-window')).not.toBeVisible();
});

test('[3] articulation tool sets stacc', async ({ page }) => {
  const pos = await notePagePos(page, 0);
  await page.mouse.click(pos.x, pos.y);
  await page.keyboard.press('3');
  await expect(page.locator('.tool-window')).toBeVisible();
  await page.locator('.art-btn', { hasText: 'stacc.' }).click();
  const art = await page.evaluate(() => window._state.notes[0].articulation);
  expect(art).toBe('stacc');
});

test('[3] clicking current articulation clears it', async ({ page }) => {
  const pos = await notePagePos(page, 0);
  await page.mouse.click(pos.x, pos.y);
  // Set stacc
  await page.keyboard.press('3');
  await page.locator('.art-btn', { hasText: 'stacc.' }).click();
  // Clear stacc by selecting it again
  await page.keyboard.press('3');
  await page.locator('.art-btn', { hasText: 'stacc.' }).click();
  const art = await page.evaluate(() => window._state.notes[0].articulation);
  expect(art).toBeNull();
});

test('Escape closes tool window', async ({ page }) => {
  const pos = await notePagePos(page, 0);
  await page.mouse.click(pos.x, pos.y);
  await page.keyboard.press('1');
  await expect(page.locator('.tool-window')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.tool-window')).not.toBeVisible();
});
