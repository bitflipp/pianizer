import { test, expect, gotoApp, loadProject } from './helpers.js';

// Page-level centre of a curve-group handle (the first, or the matching `end`).
async function handlePagePos(page, end) {
  return page.evaluate(e => {
    const roll = window._roll, s = window._state;
    const r = document.getElementById('roll').getBoundingClientRect();
    const hs = roll._groupHandles(s.curveGroups[0]);
    const h = e ? hs.find(x => x.end === e) : hs[0];
    return { x: r.left + h.x, y: r.top + h.y };
  }, end);
}

test('scale tool [1] bakes a ramp and records a locked curve group', async ({ page }) => {
  await gotoApp(page);
  await loadProject(page);

  await page.evaluate(() => window._state.setSelection(window._state.notes.map((_, i) => i)));
  await page.keyboard.press('1');
  await page.locator('.shape-row button', { hasText: 'S-curve' }).click();
  await page.locator('.velocity-grid button', { hasText: /^30$/ }).first().click();
  await page.locator('.velocity-grid button', { hasText: /^110$/ }).first().click();

  const info = await page.evaluate(() => {
    const s = window._state;
    return {
      groups: s.curveGroups.length,
      shape: s.curveGroups[0]?.shape,
      allLocked: s.notes.every(n => s.isLocked(n)),
      firstVel: s.notes[0].velocity,
      lastVel: s.notes[s.notes.length - 1].velocity,
    };
  });
  expect(info).toMatchObject({ groups: 1, shape: 'S-curve', allLocked: true, firstVel: 30, lastVel: 110 });
});

test('clicking a handle opens the menu; Dissolve unlocks and keeps velocities', async ({ page }) => {
  await gotoApp(page);
  await loadProject(page);
  await page.evaluate(() => window._state.createCurveGroup(window._state.notes.map((_, i) => i), 40, 100, 'Linear'));

  const hd = await handlePagePos(page);
  await page.mouse.click(hd.x, hd.y);
  await expect(page.locator('.tool-window-title', { hasText: 'Curve group' })).toBeVisible();

  await page.locator('.tool-window-body button', { hasText: 'Dissolve group' }).click();
  const after = await page.evaluate(() => {
    const s = window._state;
    return { groups: s.curveGroups.length, anyLocked: s.notes.some(n => s.isLocked(n)), firstVel: s.notes[0].velocity };
  });
  expect(after).toMatchObject({ groups: 0, anyLocked: false, firstVel: 40 });
});

test('dragging a handle up raises its endpoint velocity', async ({ page }) => {
  await gotoApp(page);
  await loadProject(page);
  await page.evaluate(() => window._state.createCurveGroup(window._state.notes.map((_, i) => i), 40, 100, 'Linear'));

  const hd = await handlePagePos(page, 'to');
  await page.mouse.move(hd.x, hd.y);
  await page.mouse.down();
  await page.mouse.move(hd.x, hd.y - 40, { steps: 5 }); // up = louder
  await page.mouse.up();

  const to = await page.evaluate(() => window._state.curveGroups[0].to);
  expect(to).toBeGreaterThan(100);
});

test('locked notes resist Delete', async ({ page }) => {
  await gotoApp(page);
  await loadProject(page);
  const before = await page.evaluate(() => window._state.notes.length);
  await page.evaluate(() => {
    const s = window._state;
    s.createCurveGroup(s.notes.map((_, i) => i), 40, 100, 'Linear');
    s.setSelection(s.notes.map((_, i) => i));
  });
  await page.keyboard.press('Delete');
  const after = await page.evaluate(() => window._state.notes.length);
  expect(after).toBe(before);
});
