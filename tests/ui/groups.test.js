import { test, expect, gotoApp, loadProject, notePagePos } from './helpers.js';

test('Group tool [1] groups the selection; a member selects alone, a second click selects the group', async ({ page }) => {
  await gotoApp(page);
  await loadProject(page);

  await page.evaluate(() => window._state.setSelection(window._state.notes.map((_, i) => i)));
  await page.keyboard.press('1');
  await page.locator('.tool-window-body button', { hasText: 'Group selection' }).click();

  const info = await page.evaluate(() => {
    const s = window._state;
    return { groups: s.curveGroups.length, members: s.curveGroups[0]?.members.length };
  });
  expect(info).toMatchObject({ groups: 1, members: 3 });

  // Clear, then a first click on a member selects only that note.
  await page.evaluate(() => window._state.setSelection([]));
  const pos = await notePagePos(page, 1);
  await page.mouse.click(pos.x, pos.y);
  let sel = await page.evaluate(() => [...window._state.selectedNoteIndices].sort((a, b) => a - b));
  expect(sel).toEqual([1]);

  // Clicking the already-selected member promotes to the whole group.
  await page.mouse.click(pos.x, pos.y);
  sel = await page.evaluate(() => [...window._state.selectedNoteIndices].sort((a, b) => a - b));
  expect(sel).toEqual([0, 1, 2]);
});

test('Group tool [1] ungroups a selected group', async ({ page }) => {
  await gotoApp(page);
  await loadProject(page);
  await page.evaluate(() => {
    const s = window._state;
    s.createGroup([0, 1, 2]);
    s.setSelection([0, 1, 2]);
  });

  await page.keyboard.press('1');
  await page.locator('.tool-window-body button', { hasText: /^Ungroup$/ }).click();

  const groups = await page.evaluate(() => window._state.curveGroups.length);
  expect(groups).toBe(0);
});

test('Curve tool [2] bakes a ramp without creating a group or locking', async ({ page }) => {
  await gotoApp(page);
  await loadProject(page);

  await page.evaluate(() => window._state.setSelection(window._state.notes.map((_, i) => i)));
  await page.keyboard.press('2');
  await page.locator('.shape-row button', { hasText: 'S-curve' }).click();
  await page.locator('.velocity-grid button', { hasText: /^30$/ }).first().click();
  await page.locator('.velocity-grid button', { hasText: /^110$/ }).first().click();

  const info = await page.evaluate(() => {
    const s = window._state;
    return {
      groups: s.curveGroups.length,
      firstVel: s.notes[0].velocity,
      lastVel: s.notes[s.notes.length - 1].velocity,
    };
  });
  expect(info).toMatchObject({ groups: 0, firstVel: 30, lastVel: 110 });
});

test('rubber-band selection skips grouped notes', async ({ page }) => {
  await gotoApp(page);
  await loadProject(page);

  // Group notes 0 and 1; note 2 stays ungrouped.
  await page.evaluate(() => window._state.createGroup([0, 1]));

  // A rubber-band rectangle covering all three notes. The mousedown corner sits in
  // the empty pitch row above the lowest-onset note so it starts a rect drag rather
  // than grabbing a note. Coords are clamped inside the content area (past the
  // keyboard strip / ruler).
  const box = await page.evaluate(() => {
    const roll = window._roll, s = window._state;
    const r = document.getElementById('roll').getBoundingClientRect();
    const KEY_WIDTH = 36, HEADER_HEIGHT = 24;
    let xL = Infinity, xR = -Infinity, top = Infinity, bot = -Infinity;
    for (const n of s.notes) {
      const x = roll.tickToX(n.startTick), w = roll._noteWidthPx(n);
      const y = roll.pitchToY(n.pitch);
      xL = Math.min(xL, x); xR = Math.max(xR, x + w);
      top = Math.min(top, y); bot = Math.max(bot, y + roll.noteHeight);
    }
    return {
      start: { x: r.left + Math.max(KEY_WIDTH + 2, xL), y: r.top + Math.max(HEADER_HEIGHT + 2, top) },
      end:   { x: r.left + xR, y: r.top + bot },
    };
  });

  await page.mouse.move(box.start.x, box.start.y);
  await page.mouse.down();
  await page.mouse.move(box.end.x, box.end.y, { steps: 10 });
  await page.mouse.up();

  const sel = await page.evaluate(() => [...window._state.selectedNoteIndices].sort());
  // Only note 2 (ungrouped) is selected; the grouped members are skipped.
  expect(sel).toEqual([2]);
});

test('grouped notes are deletable', async ({ page }) => {
  await gotoApp(page);
  await loadProject(page);
  await page.evaluate(() => {
    const s = window._state;
    s.createGroup(s.notes.map((_, i) => i));
    s.setSelection(s.notes.map((_, i) => i));
  });
  await page.keyboard.press('Delete');
  const after = await page.evaluate(() => ({ notes: window._state.notes.length, groups: window._state.curveGroups.length }));
  expect(after).toEqual({ notes: 0, groups: 0 });
});
