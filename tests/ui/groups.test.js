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

test('clicking a non-endpoint member note opens the menu', async ({ page }) => {
  await gotoApp(page);
  await loadProject(page);
  await page.evaluate(() => window._state.createCurveGroup(window._state.notes.map((_, i) => i), 40, 100, 'Linear'));

  // Centre of an inner member's box — past its endpoint label, so this exercises
  // the note-body hit, not the label hit.
  const body = await page.evaluate(() => {
    const roll = window._roll, s = window._state;
    const r = document.getElementById('roll').getBoundingClientRect();
    // A member that is neither the earliest nor latest onset.
    const onsets = s.notes.map(n => n.startTick);
    const min = Math.min(...onsets), max = Math.max(...onsets);
    const n = s.notes.find(x => x.startTick !== min && x.startTick !== max) ?? s.notes[1];
    const nx = roll.tickToX(n.startTick), w = roll._noteWidthPx(n);
    return { x: r.left + nx + w / 2, y: r.top + roll.pitchToY(n.pitch) + roll.noteHeight / 2 };
  });
  await page.mouse.click(body.x, body.y);
  await expect(page.locator('.tool-window-title', { hasText: 'Curve group' })).toBeVisible();
});

test('handle menu re-picks the ramp with the same two-click picker', async ({ page }) => {
  await gotoApp(page);
  await loadProject(page);
  await page.evaluate(() => window._state.createCurveGroup(window._state.notes.map((_, i) => i), 40, 100, 'Linear'));

  const hd = await handlePagePos(page, 'to');
  await page.mouse.click(hd.x, hd.y);
  await expect(page.locator('.tool-window-title', { hasText: 'Curve group' })).toBeVisible();

  // Same two-click flow as creating: start velocity, then end velocity.
  await page.locator('.velocity-grid button', { hasText: /^20$/ }).first().click();
  await page.locator('.velocity-grid button', { hasText: /^90$/ }).first().click();

  const after = await page.evaluate(() => {
    const s = window._state;
    return {
      from: s.curveGroups[0].from, to: s.curveGroups[0].to,
      firstVel: s.notes[0].velocity, lastVel: s.notes[s.notes.length - 1].velocity,
    };
  });
  expect(after).toMatchObject({ from: 20, to: 90, firstVel: 20, lastVel: 90 });
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
