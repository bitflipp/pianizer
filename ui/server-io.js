// ui/server-io.js
// Client for the optional Go+MariaDB server-side project storage API (see
// internal/api on the server side). Every explicit "Save to server" writes
// a new, immutable revision of a named project; a version-history window
// lets you browse and load older revisions. Purely additive — the local
// gzip save/load and localStorage autosave in index.html are untouched and
// keep working with no server involved.

const linkKey = pieceId => `pianizer-server-project-${pieceId}`;

function safeSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {}
}

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

function formatDate(iso) {
  return iso ? new Date(iso).toLocaleString() : '—';
}

function makeRow(...cells) {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex; align-items:center; gap:6px; padding:3px 0; border-bottom:1px solid #333;';
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

function makeErrorLine() {
  const el = document.createElement('div');
  el.style.cssText = 'color:#e88; font-size:11px; margin:4px 0; display:none;';
  return el;
}

function showError(el, err) {
  el.textContent = err.message || String(err);
  el.style.display = 'block';
}

async function loadRevisionInto(ctx, projectId, revisionNo, linkedName) {
  const { state, fitView, restoreView } = ctx;
  const data = await getRevision(projectId, revisionNo);
  state.loadProject(data);
  fitView();
  restoreView();
  setLinkedProject(state.pieceId, { id: projectId, name: linkedName });
}

// "Projects…" window: browse existing server projects, or save the
// currently-loaded piece as a brand-new one.
export function openProjectsWindow(ctx) {
  const { state, openToolWindow } = ctx;

  openToolWindow('Projects', (body, closeWindow) => {
    const errorEl = makeErrorLine();
    const listEl = document.createElement('div');
    listEl.textContent = 'Loading…';

    body.appendChild(listEl);
    body.appendChild(errorEl);

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
            await loadRevisionInto(ctx, p.id, p.revisionCount, p.name);
            closeWindow();
          } catch (err) { showError(errorEl, err); }
        });
        const historyBtn = makeButton('History', () => {
          closeWindow();
          openHistoryWindowForProject(ctx, p);
        });
        listEl.appendChild(makeRow(info, loadBtn, historyBtn));
      }
    }).catch(err => {
      listEl.replaceChildren();
      showError(errorEl, err);
    });

    if (state.loaded) {
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.placeholder = 'New project name';
      nameInput.style.cssText = 'width:100%; margin-top:8px; background:#222; color:#fff; border:1px solid #666; font:12px monospace; padding:4px;';

      const saveAsBtn = makeButton('Save as new project', async () => {
        const name = nameInput.value.trim();
        if (!name) return;
        try {
          const project = await createProject(name);
          await createRevision(project.id, state.saveProject());
          setLinkedProject(state.pieceId, project);
          closeWindow();
        } catch (err) { showError(errorEl, err); }
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
    const errorEl = makeErrorLine();
    const listEl = document.createElement('div');
    listEl.textContent = 'Loading…';
    body.appendChild(listEl);
    body.appendChild(errorEl);

    listRevisions(project.id).then(revisions => {
      listEl.replaceChildren();
      for (const r of revisions) {
        const info = makeLabel(`Rev. ${r.revisionNo} · ${formatDate(r.createdAt)} · ${r.sizeBytes}B`, true);
        const loadBtn = makeButton('Load', async () => {
          try {
            await loadRevisionInto(ctx, project.id, r.revisionNo, project.name);
            closeWindow();
          } catch (err) { showError(errorEl, err); }
        });
        listEl.appendChild(makeRow(info, loadBtn));
      }
    }).catch(err => {
      listEl.replaceChildren();
      showError(errorEl, err);
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
        openProjectsWindow(ctx);
      });
      btn.style.marginTop = '6px';
      body.appendChild(btn);
    });
    return;
  }
  openHistoryWindowForProject(ctx, linked);
}

// "Save to server" toolbar action: saves straight to the linked project if
// one exists, otherwise opens the Projects window to name/create one.
export async function saveRevision(ctx) {
  const { state } = ctx;
  if (!state.loaded) return;

  const linked = getLinkedProject(state.pieceId);
  if (!linked) {
    openProjectsWindow(ctx);
    return;
  }

  try {
    await createRevision(linked.id, state.saveProject());
  } catch (err) {
    alert('Could not save to server: ' + err.message);
  }
}
