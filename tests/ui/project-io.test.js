import { test, expect, gotoApp, loadProject, TEST_PROJECT } from './helpers.js';
import { readFileSync } from 'fs';

test.beforeEach(async ({ page }) => {
  await gotoApp(page);
  await loadProject(page);
});

// Trigger the toolbar's save-project handler and return the downloaded bytes.
async function saveAndCapture(page) {
  const downloadPromise = page.waitForEvent('download');
  await page.evaluate(() => document.dispatchEvent(new Event('save-project')));
  const download = await downloadPromise;
  return { name: download.suggestedFilename(), buffer: readFileSync(await download.path()) };
}

// Feed a buffer back through the load-project file input.
async function loadBuffer(page, name, buffer) {
  page.once('filechooser', fc => fc.setFiles({ name, mimeType: 'application/octet-stream', buffer }));
  await page.evaluate(() => document.dispatchEvent(new Event('load-project')));
}

test('saves a gzip-compressed .json.gz file named with a timestamp', async ({ page }) => {
  const { name, buffer } = await saveAndCapture(page);
  // YYYYMMDD-HHmm.json.gz
  expect(name).toMatch(/^\d{8}-\d{4}\.json\.gz$/);
  // gzip magic bytes
  expect(buffer[0]).toBe(0x1f);
  expect(buffer[1]).toBe(0x8b);
});

test('round-trips a project through save and reload', async ({ page }) => {
  const { name, buffer } = await saveAndCapture(page);

  // Replace the loaded state so a successful reload is observable.
  await page.evaluate(() => window._testLoad({ ...window._state.saveProject(), notes: [] }));
  expect(await page.evaluate(() => window._state.notes.length)).toBe(0);

  await loadBuffer(page, name, buffer);
  await page.waitForFunction(() => window._state.notes.length === 3);
});

test('loads a legacy uncompressed .json project', async ({ page }) => {
  await page.evaluate(() => window._testLoad({ ...window._state.saveProject(), notes: [] }));
  expect(await page.evaluate(() => window._state.notes.length)).toBe(0);

  const plain = Buffer.from(JSON.stringify(TEST_PROJECT), 'utf8');
  await loadBuffer(page, 'pianizer-project.json', plain);
  await page.waitForFunction(() => window._state.notes.length === 3);
});
