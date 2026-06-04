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

test('re-clicking a selected note keeps it selected', async ({ page }) => {
  const pos = await notePagePos(page, 0);
  await page.mouse.click(pos.x, pos.y);
  await page.mouse.click(pos.x, pos.y);
  const sel = await page.evaluate(() => window._state.selectedNoteIndices.size);
  expect(sel).toBe(1);
});

test('click extends selection without a modifier', async ({ page }) => {
  const p0 = await notePagePos(page, 0);
  const p1 = await notePagePos(page, 1);
  await page.mouse.click(p0.x, p0.y);
  await page.mouse.click(p1.x, p1.y);
  const sel = await page.evaluate(() => window._state.selectedNoteIndices.size);
  expect(sel).toBe(2);
});

test('click empty space clears selection', async ({ page }) => {
  const p0 = await notePagePos(page, 0);
  await page.mouse.click(p0.x, p0.y);
  // A point in an empty pitch row (well below the lowest note) that is still
  // inside the visible roll content area.
  const empty = await page.evaluate(() => {
    const note   = window._state.notes[0];
    const roll   = window._roll;
    const canvas = document.getElementById('roll');
    const rect   = canvas.getBoundingClientRect();
    return {
      x: rect.left + roll.tickToX(note.startTick) + 4,
      y: rect.top  + roll.pitchToY(note.pitch - 6) + roll.noteHeight / 2,
    };
  });
  await page.mouse.click(empty.x, empty.y);
  const sel = await page.evaluate(() => window._state.selectedNoteIndices.size);
  expect(sel).toBe(0);
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

test('[2] velocity tool sets velocity', async ({ page }) => {
  const pos = await notePagePos(page, 0);
  await page.mouse.click(pos.x, pos.y);
  await page.keyboard.press('2');
  await expect(page.locator('.tool-window')).toBeVisible();
  await page.locator('.velocity-grid button', { hasText: '80' }).click();
  const vel = await page.evaluate(() => window._state.notes[0].velocity);
  expect(vel).toBe(80);
});

test('[2] velocity tool does not open with no selection', async ({ page }) => {
  await page.keyboard.press('2');
  await expect(page.locator('.tool-window')).not.toBeVisible();
});

test('[3] duration delta tool scales note duration', async ({ page }) => {
  const pos = await notePagePos(page, 0);
  await page.mouse.click(pos.x, pos.y);
  const before = await page.evaluate(() => {
    const n = window._state.notes[0];
    return n.endTick - n.startTick;
  });
  await page.keyboard.press('3');
  await expect(page.locator('.tool-window')).toBeVisible();
  await page.locator('.delta-btn', { hasText: '-50%' }).click();
  const after = await page.evaluate(() => {
    const n = window._state.notes[0];
    return n.endTick - n.startTick;
  });
  expect(after).toBe(Math.round(before * 0.5));
});

test('Escape closes tool window', async ({ page }) => {
  const pos = await notePagePos(page, 0);
  await page.mouse.click(pos.x, pos.y);
  await page.keyboard.press('1');
  await expect(page.locator('.tool-window')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.tool-window')).not.toBeVisible();
});
