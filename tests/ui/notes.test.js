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

test('clicking another note replaces the selection', async ({ page }) => {
  const p0 = await notePagePos(page, 0);
  const p1 = await notePagePos(page, 1);
  await page.mouse.click(p0.x, p0.y);
  await page.mouse.click(p1.x, p1.y);
  const sel = await page.evaluate(() => [...window._state.selectedNoteIndices]);
  expect(sel).toEqual([1]);
});

test('Shift+click adds a note to the selection', async ({ page }) => {
  const p0 = await notePagePos(page, 0);
  const p1 = await notePagePos(page, 1);
  await page.mouse.click(p0.x, p0.y);
  await page.keyboard.down('Shift');
  await page.mouse.click(p1.x, p1.y);
  await page.keyboard.up('Shift');
  const sel = await page.evaluate(() => [...window._state.selectedNoteIndices].sort());
  expect(sel).toEqual([0, 1]);
});

// A rect anchored in the empty row just above note 0, swept down over it — starts a
// rubber-band (not a note grab) and covers note 0.
async function rectOverNote0(page, mod = null) {
  const box = await page.evaluate(() => {
    const roll = window._roll, s = window._state;
    const r = document.getElementById('roll').getBoundingClientRect();
    const KEY_WIDTH = 36, HEADER_HEIGHT = 24;
    const n = s.notes[0];
    const x = roll.tickToX(n.startTick), w = roll._noteWidthPx(n);
    const y = roll.pitchToY(n.pitch);
    return {
      start: { x: r.left + Math.max(KEY_WIDTH + 2, x - 2), y: r.top + Math.max(HEADER_HEIGHT + 2, y - 4) },
      end:   { x: r.left + x + w, y: r.top + y + roll.noteHeight },
    };
  });
  if (mod) await page.keyboard.down(mod);
  await page.mouse.move(box.start.x, box.start.y);
  await page.mouse.down();
  await page.mouse.move(box.end.x, box.end.y, { steps: 10 });
  await page.mouse.up();
  if (mod) await page.keyboard.up(mod);
}

test('drag rectangle replaces the selection with covered notes', async ({ page }) => {
  await page.evaluate(() => window._state.setSelection([1, 2]));
  await rectOverNote0(page);
  const sel = await page.evaluate(() => [...window._state.selectedNoteIndices].sort());
  expect(sel).toEqual([0]);
});

test('Shift+drag rectangle extends the selection', async ({ page }) => {
  await page.evaluate(() => window._state.setSelection([1, 2]));
  await rectOverNote0(page, 'Shift');
  const sel = await page.evaluate(() => [...window._state.selectedNoteIndices].sort());
  expect(sel).toEqual([0, 1, 2]);
});

test('Alt+drag inserts a note whose duration follows the drag (no rectangle)', async ({ page }) => {
  await page.evaluate(() => window._state.setSelection([0, 1, 2]));
  await rectOverNote0(page, 'Alt');
  // No rubber-band: instead a 4th note is inserted, spanning the dragged width and
  // selected on its own. The Alt-drag never starts a rect.
  const count  = await page.evaluate(() => window._state.notes.length);
  const active = await page.evaluate(() => window._roll._rectSelActive);
  const sel    = await page.evaluate(() => [...window._state.selectedNoteIndices]);
  const dur    = await page.evaluate(() => {
    const n = window._state.notes[[...window._state.selectedNoteIndices][0]];
    return n.endTick - n.startTick;
  });
  expect(count).toBe(4);
  expect(active).toBe(false);
  expect(sel.length).toBe(1);
  expect(dur).toBeGreaterThan(0);
});

test('Alt+click inserts a note one snap-step long at the cursor', async ({ page }) => {
  // An empty point a few rows below note 0, still inside the roll content.
  const at = await page.evaluate(() => {
    const roll = window._roll, s = window._state;
    const r = document.getElementById('roll').getBoundingClientRect();
    const n = s.notes[0];
    return {
      x: r.left + roll.tickToX(n.startTick) + 10,
      y: r.top  + roll.pitchToY(n.pitch - 5) + roll.noteHeight / 2,
    };
  });
  await page.keyboard.down('Alt');
  await page.mouse.click(at.x, at.y);
  await page.keyboard.up('Alt');
  const count = await page.evaluate(() => window._state.notes.length);
  const dur   = await page.evaluate(() => {
    const n = window._state.notes[[...window._state.selectedNoteIndices][0]];
    return n.endTick - n.startTick;
  });
  // Default duration is one snap step at the current grid (not a whole beat).
  const grid = await page.evaluate(() => window._snapGridTicks(window._state.snapGrid, window._state.ticksPerBeat));
  expect(count).toBe(4);
  expect(dur).toBe(grid);
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

// Drag from a note's body/edge: optional modifier, dx/dy in target ticks/rows.
async function dragNote(page, { noteIndex, deltaTicks = 0, deltaRows = 0, fromEdge = null, mod = null }) {
  const d = await page.evaluate(({ i, dt, dr, edge }) => {
    const roll = window._roll, s = window._state;
    const r = document.getElementById('roll').getBoundingClientRect();
    const n = s.notes[i];
    const w = roll._noteWidthPx(n);
    const anchorTick = edge === 'right' ? n.endTick
                     : edge === 'left'  ? n.startTick
                     : n.startTick;                       // body → use centre x below
    const sx = edge ? roll.tickToX(anchorTick) : roll.tickToX(n.startTick) + w / 2;
    const sy = roll.pitchToY(n.pitch) + roll.noteHeight / 2;
    return {
      sx: r.left + sx,                       sy: r.top + sy,
      ex: r.left + sx + dt * roll.pixelsPerTick,
      ey: r.top  + sy - dr * roll.noteHeight,   // +rows = up in pitch
    };
  }, { i: noteIndex, dt: deltaTicks, dr: deltaRows, edge: fromEdge });

  if (mod) await page.keyboard.down(mod);
  await page.mouse.move(d.sx, d.sy);
  await page.mouse.down();
  await page.mouse.move(d.ex, d.ey, { steps: 10 });
  await page.mouse.up();
  if (mod) await page.keyboard.up(mod);
}

// ── editing: move / resize (no modifier) ──────────────────────────────────────

test('drag note body moves it horizontally (timing)', async ({ page }) => {
  await dragNote(page, { noteIndex: 0, deltaTicks: 480 });
  const n = await page.evaluate(() => window._state.notes[0]);
  expect(n.startTick).toBeGreaterThan(0);
  expect(n.pitch).toBe(60);                  // axis-locked: pitch untouched
  expect(n.endTick - n.startTick).toBe(480); // duration preserved
});

test('drag note body up changes pitch (axis-locked, timing untouched)', async ({ page }) => {
  await dragNote(page, { noteIndex: 0, deltaRows: 2 });
  const n = await page.evaluate(() => window._state.notes[0]);
  expect(n.pitch).toBe(62);
  expect(n.startTick).toBe(0);
});

test('drag right edge resizes the note end', async ({ page }) => {
  await dragNote(page, { noteIndex: 0, deltaTicks: 480, fromEdge: 'right' });
  const n = await page.evaluate(() => window._state.notes[0]);
  expect(n.startTick).toBe(0);
  expect(n.endTick).toBeGreaterThan(480);
});

test('resizing an unselected note selects it', async ({ page }) => {
  await page.evaluate(() => window._state.setSelection([1]));
  await dragNote(page, { noteIndex: 0, deltaTicks: 480, fromEdge: 'right' });
  const sel = await page.evaluate(() => [...window._state.selectedNoteIndices].sort());
  expect(sel).toEqual([0]);
});

test('resizing keeps a multi-note selection intact', async ({ page }) => {
  await page.evaluate(() => window._state.setSelection([0, 1, 2]));
  await dragNote(page, { noteIndex: 0, deltaTicks: 480, fromEdge: 'right' });
  const sel = await page.evaluate(() => [...window._state.selectedNoteIndices].sort());
  expect(sel).toEqual([0, 1, 2]);
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
