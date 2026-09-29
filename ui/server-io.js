// ui/server-io.js
// Client for the optional Go+MariaDB server-side project storage API (see
// internal/api on the server side). Every explicit "Save to server" writes
// a new, immutable revision of a named project; a version-history window
// lets you browse and load older revisions. Purely additive — the local
// gzip save/load and localStorage autosave in index.html are untouched and
// keep working with no server involved.

import { safeSet } from './dom-utils.js';

const linkKey = pieceId => `pianizer-server-project-${pieceId}`;

// How long the Delete button stays disabled after the first click before it can be confirmed.
const DELETE_ARM_MS = 3000;

function safeGet(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}

// Remembers which server-side project a loaded piece belongs to, keyed by
// pieceId the same way index.html's per-piece view state is (viewKey()) —
// so a repeat "Save to server" doesn't need to ask again. Because
// saveProject()/loadProject() always round-trip pieceId, loading an old
// revision automatically resolves back to the same linked project.
export function getLinkedProject(pieceId) {
  return pieceId ? safeGet(linkKey(pieceId)) : null;
}

export function setLinkedProject(pieceId, project) {
  if (!pieceId) return;
  safeSet(linkKey(pieceId), { id: project.id, name: project.name });
}

async function request(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body:    body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let message = res.statusText;
    try { message = (await res.json()).error || message; } catch (_) {}
    throw new Error(message);
  }
  return res.json();
}

export const listProjects   = ()                    => request('GET',  '/api/projects').then(r => r.projects);
export const createProject  = name                  => request('POST', '/api/projects', { name });
export const listRevisions  = projectId              => request('GET',  `/api/projects/${projectId}/revisions`).then(r => r.revisions);
export const getRevision    = (projectId, revNo)     => request('GET',  `/api/projects/${projectId}/revisions/${revNo}`);
export const createRevision = (projectId, projectJson) => request('POST', `/api/projects/${projectId}/revisions`, projectJson);
export const deleteRevision = (projectId, revNo)     => request('DELETE', `/api/projects/${projectId}/revisions/${revNo}`);

function formatDate(iso) {
  return iso ? new Date(iso).toLocaleString() : '—';
}

// A vertical list of rows, spaced by gap alone — no separator lines, so the
// list's edges stay flush with the tool-window body's own 5px padding.
function makeList() {
  const el = document.createElement('div');
  el.style.cssText = 'display:flex; flex-direction:column; gap:5px;';
  return el;
}

function makeRow(...cells) {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex; align-items:center; gap:5px;';
  for (const cell of cells) row.appendChild(cell);
  return row;
}

function makeLabel(text, grow) {
  const span = document.createElement('span');
  span.textContent = text;
  if (grow) span.style.flex = '1 1 auto';
  return span;
}

function makeButton(text, onClick) {
  const btn = document.createElement('button');
  btn.className = 'delta-btn';
  btn.textContent = text;
  btn.addEventListener('click', ev => { ev.stopPropagation(); onClick(); });
  return btn;
}

// A two-step confirm button: the first click arms it — disabled for DELETE_ARM_MS
// while a red bar drains left-to-right — then it re-enables with a red
// background (primed) and a second click fires `onConfirm`. Guards against
// an accidental double-click immediately performing something destructive.
function makeDeleteButton(onConfirm) {
  const btn = document.createElement('button');
  btn.className = 'delta-btn';
  btn.textContent = 'Delete';
  btn.style.cssText = 'position:relative; overflow:hidden;';

  let armed = false;

  function reset() {
    armed = false;
    btn.style.background = '';
    btn.style.borderColor = '';
  }

  btn.addEventListener('click', ev => {
    ev.stopPropagation();
    if (armed) {
      reset();
      onConfirm();
      return;
    }

    btn.disabled = true;
    const bar = document.createElement('div');
    bar.style.cssText = 'position:absolute; left:0; bottom:0; height:2px; width:100%; background:#e55; transform-origin:left; transition:transform ' + DELETE_ARM_MS + 'ms linear;';
    btn.appendChild(bar);
    requestAnimationFrame(() => { bar.style.transform = 'scaleX(0)'; });

    setTimeout(() => {
      bar.remove();
      btn.disabled = false;
      armed = true;
      btn.style.background = '#5c1c1c';
      btn.style.borderColor = '#e55';
    }, DELETE_ARM_MS);
  });

  return btn;
}

// User-facing feedback surfaces in the status bar (index.html), not in the
// tool window itself — same 'roll-flash' event ui/roll.js uses for its own
// transient messages.
function flash(message, isError) {
  document.dispatchEvent(new CustomEvent('roll-flash', { detail: { message, isError } }));
}

function flashError(err) {
  const message = err.message || String(err);
  flash(message.charAt(0).toUpperCase() + message.slice(1), true);
}

async function loadRevisionInto(ctx, projectId, revisionNo, linkedName) {
  const { state, fitView, restoreView } = ctx;
  const data = await getRevision(projectId, revisionNo);
  state.loadProject(data);
  fitView();
  restoreView();
  setLinkedProject(state.pieceId, { id: projectId, name: linkedName });
}

// "Server…" window: browse existing server projects, or save the
// currently-loaded piece as a brand-new one.
export function openServerWindow(ctx) {
  const { state, openToolWindow } = ctx;

  openToolWindow('Server', (body, closeWindow) => {
    const listEl = makeList();
    listEl.textContent = 'Loading…';

    body.appendChild(listEl);

    listProjects().then(projects => {
      listEl.replaceChildren();
      if (projects.length === 0) {
        listEl.appendChild(makeLabel('No projects saved yet.'));
        return;
      }
      for (const p of projects) {
        const info = makeLabel(`${p.name} — ${p.revisionCount} rev. · ${formatDate(p.lastSavedAt)}`, true);
        const loadBtn = makeButton('Load latest', async () => {
          if (p.revisionCount === 0) return;
          try {
            const revisions = await listRevisions(p.id);
            if (revisions.length === 0) return;
            await loadRevisionInto(ctx, p.id, revisions[0].revisionNo, p.name); // newest first
            closeWindow();
          } catch (err) { flashError(err); }
        });
        const historyBtn = makeButton('History', () => {
          closeWindow();
          openHistoryWindowForProject(ctx, p);
        });
        listEl.appendChild(makeRow(info, loadBtn, historyBtn));
      }
    }).catch(err => {
      listEl.replaceChildren();
      flashError(err);
    });

    if (state.loaded) {
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.placeholder = 'New project name';
      nameInput.style.cssText = 'width:100%; margin-top:5px; background:#222; color:#fff; border:1px solid #666; font:12px monospace; padding:4px;';

      const saveAsBtn = makeButton('Save as new project', async () => {
        const name = nameInput.value.trim();
        if (!name) return;
        try {
          const project = await createProject(name);
          await createRevision(project.id, state.saveProject());
          setLinkedProject(state.pieceId, project);
          closeWindow();
          flash('Saved to server · ' + name);
        } catch (err) { flashError(err); }
      });
      saveAsBtn.style.marginTop = '4px';

      body.appendChild(nameInput);
      body.appendChild(saveAsBtn);
    }
  });
}

function openHistoryWindowForProject(ctx, project) {
  const { openToolWindow } = ctx;

  openToolWindow('Version history — ' + project.name, (body, closeWindow) => {
    const listEl = makeList();
    listEl.textContent = 'Loading…';
    body.appendChild(listEl);

    listRevisions(project.id).then(revisions => {
      listEl.replaceChildren();
      for (const r of revisions) {
        const info = makeLabel(`Rev. ${r.revisionNo} · ${formatDate(r.createdAt)} · ${r.sizeBytes}B`, true);
        const loadBtn = makeButton('Load', async () => {
          try {
            await loadRevisionInto(ctx, project.id, r.revisionNo, project.name);
            closeWindow();
          } catch (err) { flashError(err); }
        });
        const row = makeRow(info, loadBtn);
        const deleteBtn = makeDeleteButton(async () => {
          try {
            await deleteRevision(project.id, r.revisionNo);
            row.remove();
          } catch (err) { flashError(err); }
        });
        row.appendChild(deleteBtn);
        listEl.appendChild(row);
      }
    }).catch(err => {
      listEl.replaceChildren();
      flashError(err);
    });
  });
}

// "Version history" toolbar action: resolves the project the current piece
// is linked to and opens its history, or prompts to save-as-new first.
export function openHistoryWindow(ctx) {
  const { state, openToolWindow } = ctx;
  const linked = getLinkedProject(state.pieceId);
  if (!linked) {
    openToolWindow('Version history', (body, closeWindow) => {
      body.appendChild(makeLabel('Save this piece to a project first.'));
      const btn = makeButton('Save to server…', () => {
        closeWindow();
        openServerWindow(ctx);
      });
      btn.style.marginTop = '5px';
      body.appendChild(btn);
    });
    return;
  }
  openHistoryWindowForProject(ctx, linked);
}

// "Save to server" toolbar action: saves straight to the linked project if
// one exists, otherwise opens the Server window to name/create one.
export async function saveRevision(ctx) {
  const { state } = ctx;
  if (!state.loaded) return;

  const linked = getLinkedProject(state.pieceId);
  if (!linked) {
    openServerWindow(ctx);
    return;
  }

  try {
    await createRevision(linked.id, state.saveProject());
    flash('Saved to server · ' + linked.name);
  } catch (err) {
    flashError(err);
  }
}
