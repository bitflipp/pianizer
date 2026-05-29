import { test as base, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

export { expect };

const __dir = dirname(fileURLToPath(import.meta.url));
export const TEST_PROJECT = JSON.parse(
  readFileSync(join(__dir, 'fixtures/project.json'), 'utf8')
);

// Custom `test` fixture: clears localStorage before every page load so
// autosave never interferes with test state.
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(() => localStorage.clear());
    await use(page);
  },
});

// Navigate to the app and wait until the canvas is sized and the module is ready.
export async function gotoApp(page) {
  await page.goto('/');
  await page.waitForFunction(() => {
    const canvas = document.getElementById('roll');
    return canvas && canvas.width > 0 && typeof window._state !== 'undefined';
  });
}

// Call window._testLoad with the given project data, then wait for the roll to
// reflect the loaded state.
export async function loadProject(page, project = TEST_PROJECT) {
  await page.evaluate(data => window._testLoad(data), project);
  await page.waitForFunction(() => window._state.loaded);
}

// Return the page-level (clientX/clientY) centre of note[noteIndex].
export async function notePagePos(page, noteIndex) {
  return page.evaluate(i => {
    const note   = window._state.notes[i];
    const roll   = window._roll;
    const canvas = document.getElementById('roll');
    const rect   = canvas.getBoundingClientRect();
    const noteW  = (note.endTick - note.startTick) * roll.pixelsPerTick;
    return {
      x: rect.left + roll.tickToX(note.startTick) + noteW / 2,
      y: rect.top  + roll.pitchToY(note.pitch)    + roll.noteHeight / 2,
    };
  }, noteIndex);
}
