import { test, expect, gotoApp, loadProject, TEST_PROJECT } from './helpers.js';

// TEST_PROJECT's fixed pieceId, so the server-project link key is predictable.
const LINK_KEY = 'pianizer-server-project-test-001';

test.beforeEach(async ({ page }) => {
  await gotoApp(page);
  await loadProject(page);
});

test('save to server with no prior link creates a project then a revision', async ({ page }) => {
  const createCalls = [];
  const revisionCalls = [];

  await page.route('**/api/projects', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    createCalls.push(route.request().postDataJSON());
    await route.fulfill({
      status: 201,
      json: { id: 1, name: 'Nocturne', createdAt: '2026-01-01T00:00:00Z', revisionCount: 0, lastSavedAt: null },
    });
  });
  await page.route('**/api/projects/1/revisions', async route => {
    revisionCalls.push(route.request().postDataJSON());
    await route.fulfill({ status: 201, json: { revisionNo: 1, createdAt: '2026-01-01T00:00:01Z' } });
  });

  await page.click('ph-toolbar >> text=Save to server');
  await page.fill('input[placeholder="New project name"]', 'Nocturne');
  await page.click('button:has-text("Save as new project")');

  await expect.poll(() => revisionCalls.length).toBe(1);
  expect(createCalls[0]).toEqual({ name: 'Nocturne' });
  expect(revisionCalls[0].notes).toHaveLength(3);

  const linked = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), LINK_KEY);
  expect(linked).toEqual({ id: 1, name: 'Nocturne' });

  await expect(page.locator('#status')).toHaveText('Saved to server · Nocturne');
});

test('save to server with an existing link posts straight to revisions', async ({ page }) => {
  await page.evaluate(key => {
    localStorage.setItem(key, JSON.stringify({ id: 7, name: 'Etude' }));
  }, LINK_KEY);

  let projectsPosted = false;
  const revisionCalls = [];
  await page.route('**/api/projects', async route => {
    if (route.request().method() === 'POST') projectsPosted = true;
    return route.fallback();
  });
  await page.route('**/api/projects/7/revisions', async route => {
    revisionCalls.push(route.request().postDataJSON());
    await route.fulfill({ status: 201, json: { revisionNo: 2, createdAt: '2026-01-01T00:00:02Z' } });
  });

  await page.click('ph-toolbar >> text=Save to server');

  await expect.poll(() => revisionCalls.length).toBe(1);
  expect(projectsPosted).toBe(false);
  await expect(page.locator('#status')).toHaveText('Saved to server · Etude');
});

test('a failed save to server flashes the error in the status bar, not a tool window', async ({ page }) => {
  await page.evaluate(key => {
    localStorage.setItem(key, JSON.stringify({ id: 9, name: 'Barcarolle' }));
  }, LINK_KEY);

  await page.route('**/api/projects/9/revisions', async route => {
    await route.fulfill({ status: 500, json: { error: 'database is on fire' } });
  });

  await page.click('ph-toolbar >> text=Save to server');

  const status = page.locator('#status');
  await expect(status).toHaveText('Database is on fire');
  await expect(status).toHaveCSS('color', 'rgb(238, 136, 136)');
  await expect(page.locator('.tool-window')).toHaveCount(0);
});

test('version history lists and loads a revision', async ({ page }) => {
  await page.evaluate(key => {
    localStorage.setItem(key, JSON.stringify({ id: 3, name: 'Prelude' }));
  }, LINK_KEY);

  await page.route('**/api/projects/3/revisions', async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      status: 200,
      json: {
        revisions: [
          { revisionNo: 2, createdAt: '2026-01-02T00:00:00Z', sizeBytes: 200 },
          { revisionNo: 1, createdAt: '2026-01-01T00:00:00Z', sizeBytes: 100 },
        ],
      },
    });
  });
  const olderRevision = { ...TEST_PROJECT, notes: [TEST_PROJECT.notes[0]] };
  await page.route('**/api/projects/3/revisions/1', async route => {
    await route.fulfill({ status: 200, json: olderRevision });
  });

  await page.click('ph-toolbar >> text=Version history');
  await expect(page.locator('text=Rev. 2')).toBeVisible();
  await expect(page.locator('text=Rev. 1')).toBeVisible();

  await page.locator('div:has-text("Rev. 1") >> button:has-text("Load")').last().click();

  await page.waitForFunction(() => window._state.notes.length === 1);
});

test('version history deletes a revision after the two-step confirm', async ({ page }) => {
  await page.evaluate(key => {
    localStorage.setItem(key, JSON.stringify({ id: 5, name: 'Impromptu' }));
  }, LINK_KEY);

  await page.route('**/api/projects/5/revisions', async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      status: 200,
      json: { revisions: [{ revisionNo: 1, createdAt: '2026-01-01T00:00:00Z', sizeBytes: 100 }] },
    });
  });
  let deleteCalls = 0;
  await page.route('**/api/projects/5/revisions/1', async route => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    deleteCalls++;
    await route.fulfill({ status: 200, json: { deleted: true } });
  });

  await page.click('ph-toolbar >> text=Version history');
  const row = page.locator('div:has-text("Rev. 1")').last();
  const deleteBtn = row.locator('button:has-text("Delete")');
  await expect(deleteBtn).toBeVisible();

  await deleteBtn.click();
  await expect(deleteBtn).toBeDisabled();
  expect(deleteCalls).toBe(0);

  await expect(deleteBtn).toBeEnabled({ timeout: 4000 });
  await deleteBtn.click();

  await expect.poll(() => deleteCalls).toBe(1);
  await expect(row).toHaveCount(0);
});
