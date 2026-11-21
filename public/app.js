import { layout, edgePath, laneX, ROW, distanceToPolyline } from './layout.js';

const $ = (sel) => document.querySelector(sel);
const vp = $('#viewport');
const world = $('#world');
const svg = $('#graph');
const sheet = $('#sheet');

// A change you can still rewrite is a card; immutable history is a slim row.
const CARD_W = 292;
const CARD_GAP = 18;
const SLIM_H = 34;
const TIMELINE_OPS = 14;
const token = new URLSearchParams(location.hash.slice(1)).get('token');
const fineKeyboard = matchMedia('(hover: hover) and (pointer: fine)');

const S = {
  state: null,
  json: '',
  lay: null,
  byId: new Map(),
  rows: [],
  selected: null, // change id
  mode: 'NORMAL',
  pick: null, // { node, cursor }
  at: null, // operation id being looked back at, or null for the present
  view: { x: 8, y: 8, k: 1 },
  revset: localStorage.getItem('jj-graph.revset') ?? '',
  busy: false,
  edgePoints: null,
  firstRender: true,
  // Whether the status line lists keys or gestures: keys on a desktop
  // pointer, and from the first key press on anything else.
  keyboard: fineKeyboard.matches,
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const firstLine = (s) => s.split('\n')[0];
const rev = (n) => (n.divergent || n.hidden ? n.id : n.change);
const short = (n) => n.change.slice(0, Math.max(n.prefix.length, 4));
const nameOf = (n) => firstLine(n.description) || short(n);
const selectedNode = () => S.rows.find((n) => n.change === S.selected) ?? null;

/** Same shortening the server applies to a step's label. */
function displayCommand(args) {
  return 'jj ' + args.map((a) => {
    if (/^[k-z]{32}$/.test(a) || /^[0-9a-f]{40}$/.test(a)) return a.slice(0, 8);
    return /^[\w@./:=+-]+$/.test(a) ? a : JSON.stringify(a);
  }).join(' ');
}

function ago(ts) {
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 90) return 'now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 86400 * 60) return `${Math.round(s / 86400)}d`;
  return `${Math.round(s / (86400 * 30))}mo`;
}

// ---------------------------------------------------------------- server

async function api(path, body) {
  const headers = {};
  if (token) headers['x-jj-graph-token'] = token;
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(path, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

function setState(state) {
  const json = JSON.stringify(state);
  if (json === S.json) return;
  S.json = json;
  S.state = state;
  render();
}

async function refresh({ quiet = false } = {}) {
  try {
    setState(await api(`/api/state?revset=${encodeURIComponent(S.revset)}${S.at ? `&at=${S.at}` : ''}`));
    $('#empty').hidden = S.rows.length > 0;
    if (!S.rows.length) $('#empty').textContent = 'No revisions match this revset.';
  } catch (err) {
    if (quiet) return;
    if (!S.state) {
      $('#empty').hidden = false;
      $('#empty').textContent = err.message;
    }
    toast(err.message, { error: true });
  }
}

async function post(path, body = {}) {
  if (S.busy) return null;
  S.busy = true;
  document.body.classList.add('busy');
  try {
    const data = await api(path, { ...body, revset: S.revset });
    S.at = null; // acting on the repository always returns to the present
    if (data.state) setState(data.state);
    return data;
  } catch (err) {
    toast(err.message, { error: true });
    return null;
  } finally {
    S.busy = false;
    document.body.classList.remove('busy');
  }
}

/** Add one jj command to the dry run and show the previewed graph. */
async function dry(args, { focus = null } = {}) {
  const data = await post('/api/dry', Array.isArray(args) ? { args } : { line: args });
  if (!data) return;
  if (!data.result.changed) toast(data.result.output);
  else announce(`Previewed ${displayCommand(Array.isArray(args) ? args : [args])}`);
  if (focus) {
    S.selected = focus;
    render();
    const n = selectedNode();
    if (n) ensureVisible(n.id);
  }
}

async function applyPlan() {
  const data = await post('/api/apply');
  if (!data) return;
  const { applied, undoOp } = data.result;
  toast(`Applied ${applied} operation${applied === 1 ? '' : 's'} to the repository.`, {
    ms: 12000,
    action: {
      label: 'Undo',
      run: async () => {
        const r = await post('/api/restore', { op: undoOp });
        if (r) toast('Restored the repository to before the apply.');
      },
    },
  });
}

// ---------------------------------------------------------------- render

function render() {
  const st = S.state;
  if (!st) return;
  S.rows = st.nodes;
  S.byId = new Map(st.nodes.map((n) => [n.id, n]));
  S.lay = layout(st.nodes, (n) => (n.immutable ? SLIM_H : ROW));
  S.edgePoints = null;
  if (S.selected && !selectedNode()) S.selected = null;
  if (S.pick && !S.byId.has(S.pick.node.id)) S.pick = null;
  if (st.viewing && S.mode === 'NORMAL') S.mode = 'HISTORY';
  if (!st.viewing && S.mode === 'HISTORY') S.mode = 'NORMAL';

  const { pos, edges, lanes, height } = S.lay;
  const width = laneX(lanes - 1) + CARD_GAP + CARD_W + 16;
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  world.style.width = `${width}px`;
  world.style.height = `${height}px`;

  // Colour says what state a change is in, never which branch it is on:
  // jj has no branches to colour, only changes and what you may do to them.
  let edgeHtml = '';
  let hitHtml = '';
  for (const e of edges) {
    const d = edgePath(e, pos);
    const trunk = e.to != null && S.byId.get(e.from).immutable && S.byId.get(e.to).immutable;
    const cls = ['edge', e.to == null && 'stub', e.to != null && e.indirect && 'indirect', trunk && 'trunk'].filter(Boolean).join(' ');
    edgeHtml += `<path class="${cls}" data-edge-line="${esc(e.key)}" d="${d}"/>`;
    if (e.to != null) hitHtml += `<path class="edge-hit" data-edge="${esc(e.key)}" d="${d}"/>`;
  }

  const touched = new Set(st.touched);
  // "auto-rebased" marks what jj moved for you because something beneath it changed.
  const STATUS = { new: 'new', edited: 'rewritten', followed: st.rewound ? 'restored' : 'auto-rebased' };
  let nodeHtml = '';
  let rowHtml = '';
  for (const n of st.nodes) {
    const p = pos.get(n.id);
    const x = laneX(p.lane);
    const left = laneX(p.reach) + CARD_GAP;
    const before = st.baseline?.[n.change];
    const status = !st.baseline ? null : !before ? 'new' : before !== n.id ? (touched.has(n.change) ? 'edited' : 'followed') : null;
    const flags = [n.wc && 'wc', n.immutable && 'immutable', n.empty && 'empty', n.conflict && 'conflict',
      status && 'changed', n.change === S.selected && 'selected'].filter(Boolean).join(' ');
    edgeHtml += `<path class="tether${n.immutable ? ' trunk' : ''}" d="M${x},${p.y} L${left},${p.y}"/>`;
    nodeHtml += `<g class="node ${flags}" data-node="${n.id}" transform="translate(${x},${p.y})">`
      + '<circle class="sel" r="15"/>'
      + (n.wc ? '<circle class="ring" r="10"/>' : '')
      + (n.immutable ? '<rect class="dot" x="-4" y="-4" width="8" height="8" transform="rotate(45)"/>' : `<circle class="dot" r="${n.wc ? 5 : 6}"/>`)
      + '<circle class="hit" r="22"/></g>';

    const root = /^0+$/.test(n.id);
    const desc = root ? 'root()' : firstLine(n.description);
    const id = short(n);
    const cid = `<span class="cid"><b>${esc(id.slice(0, n.prefix.length))}</b>${esc(id.slice(n.prefix.length))}</span>`;
    const chips = [
      ...n.workspaces.filter(() => !n.wc).map((w) => `<span class="chip tag">${esc(w)}@</span>`),
      n.conflict ? '<span class="chip flag" title="Conflicts are stored in the change. Nothing is blocked: resolve when you like.">conflict</span>' : '',
      n.divergent ? '<span class="chip flag">divergent</span>' : '',
      ...n.bookmarks.map((b) => `<span class="chip bm" data-bookmark="${esc(b.name)}">${esc(b.name)}${b.conflict ? '??' : ''}</span>`),
      ...n.tags.map((t) => `<span class="chip tag">${esc(t)}</span>`),
      ...n.remotes.map((r) => `<span class="chip remote">${esc(r)}</span>`),
    ].join('');
    const descHtml = `<div class="desc${desc ? '' : ' none'}">${desc ? esc(desc) : n.empty ? '(empty)' : '(no description)'}</div>`;
    const style = `style="left:${left}px;top:${p.y}px"`;
    if (n.immutable) {
      rowHtml += `<div class="row slim ${flags}" data-node="${n.id}" ${style}>${descHtml}${cid}${chips}</div>`;
      continue;
    }
    // A rewritten change keeps its id; only the commit underneath is new.
    const info = status && before ? `<span class="swap">${before.slice(0, 4)}→${n.id.slice(0, 4)}</span>`
      : `<span>${n.empty ? 'empty' : `${n.files} file${n.files === 1 ? '' : 's'}`} · ${ago(n.time)}</span>`;
    rowHtml += `<div class="row card ${flags}${st.viewing ? ' nogrip' : ''}" data-node="${n.id}" ${style}>`
      + (n.wc ? '<span class="tab wc">@ working copy</span>' : '')
      + (status ? `<span class="tab st">${STATUS[status]}</span>` : '')
      + (st.viewing ? '' : '<span class="grip" data-grip aria-hidden="true"></span>')
      + `<div class="body">${descHtml}<div class="meta">${cid}${chips}${info}</div></div></div>`;
  }
  $('#edges').innerHTML = edgeHtml + hitHtml;
  $('#nodes').innerHTML = nodeHtml;
  $('#labels').innerHTML = rowHtml;
  $('#overlay').innerHTML = '';

  document.body.classList.toggle('dry', st.dry.active && !st.viewing);
  document.body.classList.toggle('history', Boolean(st.viewing));
  $('#repo').textContent = st.repo.split('/').pop();
  $('#revsetText').textContent = S.revset || st.defaultRevset;
  const jjrBtn = $('#jjrBtn');
  if (jjrBtn && st.jjr?.summary) {
    const count = st.jjr.summary.diagnosticsCount;
    jjrBtn.textContent = count > 0 ? `jjr · ${count}` : 'jjr';
    jjrBtn.dataset.status = st.jjr.summary.status;
  }
  renderTimeline();
  renderPlanbar();
  renderInspector();
  renderStatus();

  if (S.firstRender && st.nodes.length) {
    S.firstRender = false;
    const wc = st.nodes.find((n) => n.wc);
    const y = wc ? pos.get(wc.id).y : 0;
    const h = vp.clientHeight;
    S.view = { x: 6, y: y > h * 0.7 ? h * 0.4 - y : 8, k: 1 };
  }
  applyView();
  if (S.pick) markPickCursor();
}

function applyView() {
  const { x, y, k } = S.view;
  world.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
  vp.style.backgroundPosition = `${x}px ${y}px`;
}

/**
 * The operation log as a strip: every dot is a state the whole repository
 * was in, the ring is now, and a dry run's steps continue past it as
 * operations that have not happened yet.
 */
function renderTimeline() {
  const st = S.state;
  const past = st.ops.slice(0, TIMELINE_OPS).reverse();
  const head = past.at(-1);
  const title = (o) => `${o.description} · ${ago(o.time)}`;
  let html = past.map((o) => {
    const cls = ['op', o.snapshot && 'snap', o === head && 'now', st.viewing === o.id && 'viewing'].filter(Boolean).join(' ');
    return `<button class="${cls}" data-op="${o.id}" title="${esc(title(o))}" aria-label="${esc(title(o))}"><i></i></button>`;
  }).join('');
  const steps = st.dry.steps.map((s) => s.label);
  const redo = [...st.dry.redo].reverse();
  if (steps.length || redo.length) html += '<span class="gap"></span>';
  [...steps, ...redo].forEach((label, i) => {
    const cls = ['op', 'plan', i >= steps.length && 'redo', !st.viewing && i === steps.length - 1 && 'viewing'].filter(Boolean).join(' ');
    html += `<button class="${cls}" data-step="${i + 1}" title="${esc(label)}" aria-label="${esc(label)}"><i></i></button>`;
  });
  const viewed = st.viewing ? st.ops.find((o) => o.id === st.viewing) : null;
  const caption = viewed ? title(viewed) : steps.length ? `now + ${steps.length} planned` : `now · ${head ? head.description : ''}`;
  $('#timeline').innerHTML = `<span class="caption" title="The operation log: every state this repository has been in">${esc(caption)}</span><span class="dots">${html}</span>`;
  const dots = $('#timeline .dots');
  dots.scrollLeft = dots.scrollWidth;
}

/** Look at the repository as of an earlier operation, or null for now. */
function travel(op) {
  const head = S.state.ops[0]?.id;
  S.at = op === head && !S.state.dry.active ? null : op;
  refresh();
}

function stepHistory(delta) {
  const ids = S.state.ops.slice(0, TIMELINE_OPS).reverse().map((o) => o.id);
  // With a dry run open, "now without the plan" is a stop of its own.
  const stops = S.state.dry.active ? [...ids, null] : [...ids.slice(0, -1), null];
  const i = Math.max(0, Math.min(stops.length - 1, stops.indexOf(S.at) + delta));
  S.at = stops[i];
  refresh();
}

function restoreHere() {
  const op = S.at;
  if (op) dry(['op', 'restore', op.slice(0, 16)]);
}

function renderPlanbar() {
  const { dry: d, baseline, nodes, viewing, ops } = S.state;
  const bar = $('#planbar');
  if (viewing) {
    const o = ops.find((x) => x.id === viewing);
    const isNow = viewing === ops[0]?.id;
    bar.innerHTML = '<div class="info"><div class="badge">HISTORY · read-only</div>'
      + `<div class="last">${esc(isNow ? 'The repository now, without the dry run' : o ? `${o.description} · ${ago(o.time).replace(/^(?!now)(.*)$/, '$1 ago')}` : viewing.slice(0, 12))}</div></div>`
      + '<button data-act="now">Back</button>'
      + (isNow ? '' : '<button class="primary apply" data-act="restore" title="Preview restoring the repository to this operation">Restore to here</button>');
    return;
  }
  if (!d.active) {
    bar.innerHTML = '<div class="info"><div class="badge"><span class="dot"></span>LIVE</div>'
      + `<div class="last tip">${d.redo.length ? 'Dry run undone.' : 'Every card is a change you can still rewrite. Drag one by its grip to try it. Nothing is written until you apply.'}</div></div>`
      + (d.redo.length ? '<button class="icon" data-act="redo" aria-label="Redo step" title="Redo">↷</button>' : '');
    return;
  }
  const present = new Set(nodes.map((n) => n.change));
  const gone = Object.keys(baseline).filter((c) => !present.has(c)).length;
  const conflicts = nodes.filter((n) => n.conflict).length;
  const notes = [
    `${d.steps.length} op${d.steps.length === 1 ? '' : 's'}`,
    gone ? `${gone} gone` : '',
    conflicts ? `<span class="warn" title="jj records conflicts in the change instead of stopping. You can apply and resolve later.">${conflicts} conflicted, not blocking</span>` : '',
    d.stale ? '<span class="warn">out of date</span>' : '',
  ].filter(Boolean).join(' · ');
  bar.innerHTML = `<button class="info" data-act="steps" title="Show the dry run's steps"><div class="badge">DRY RUN · ${notes}</div>`
    + `<div class="last${d.stale ? ' warn' : ''}">${esc(d.stale ?? d.steps.at(-1).label)}</div></button>`
    + '<button class="icon" data-act="undo" aria-label="Undo step" title="Undo last step">↶</button>'
    + (d.redo.length ? '<button class="icon" data-act="redo" aria-label="Redo step" title="Redo">↷</button>' : '')
    + '<button class="danger" data-act="discard">Discard</button>'
    + `<button class="primary apply" data-act="apply"${d.stale ? ' disabled' : ''}>Apply</button>`;
}

const ACTIONS = [
  { key: 'n', label: 'New child', run: (n) => dry(['new', rev(n)]), always: true },
  { key: 'e', label: 'Edit', run: (n) => dry(['edit', rev(n)], { focus: n.change }) },
  { key: 'd', label: 'Describe', run: (n) => describeDialog(n) },
  { key: 'm', label: 'Move…', run: (n) => startPick(n) },
  { key: 's', label: 'Squash ↓', run: (n) => dry(['squash', '-r', rev(n)]) },
  { key: 'c', label: 'Duplicate', run: (n) => dry(['duplicate', rev(n)]), always: true },
  { key: 'b', label: 'Bookmark', run: (n) => bookmarkDialog(n), always: true },
  { key: 'v', label: 'Diff', run: (n) => showDiff(n), always: true, read: true },
  { key: 'h', label: 'Evolution', run: (n) => showEvolution(n), always: true, read: true },
  { key: 'a', label: 'Abandon', run: (n) => dry(['abandon', rev(n)]), danger: true },
];
/** Whether an action is available for a change in the current mode. */
const allowed = (a, n) => (S.mode === 'HISTORY' ? Boolean(a.read) : a.always || !n.immutable);

function renderInspector() {
  const el = $('#inspector');
  const n = selectedNode();
  el.hidden = !n || S.mode === 'PICK';
  if (!n) return;
  const id = short(n);
  el.innerHTML = `<div class="who"><span class="cid"><b>${esc(id.slice(0, n.prefix.length))}</b>${esc(id.slice(n.prefix.length))}</span>`
    + `<span class="desc">${esc(nameOf(n))}</span><span class="by">${n.immutable ? 'immutable · ' : ''}${esc(n.author)}</span></div><div class="actions">`
    + ACTIONS.map((a) => `<button data-action="${a.key}" class="${a.danger ? 'danger' : ''}"`
      + `${allowed(a, n) ? '' : ' disabled'}>${a.label}<kbd>${a.key}</kbd></button>`).join('')
    + '</div>';
}

function setMode(mode) {
  S.mode = mode;
  renderStatus();
  renderInspector();
}

function renderStatus() {
  const el = $('#mode');
  el.textContent = S.mode;
  el.dataset.mode = S.mode;
  const dryOn = S.state?.dry.active;
  let hints;
  if (S.keyboard) {
    if (S.mode === 'PICK') hints = [['j/k', 'target'], ['Enter', 'choose'], ['m/Esc', 'NORMAL']];
    else if (S.mode === 'DRAG') hints = [['drop', 'on a change or edge'], ['Esc', 'NORMAL']];
    else if (S.mode === 'INPUT') hints = [['Ctrl+Enter', 'confirm'], ['Esc', 'NORMAL']];
    else if (S.mode === 'HISTORY') {
      hints = [['[ ]', 'older / newer operation'], ['Enter', 'restore to here'], ['j/k', 'select']];
      if (selectedNode()) hints.push(['v', 'diff'], ['h', 'evolution']);
      hints.push(['Esc', 'NORMAL']);
    } else {
      hints = [['j/k', 'select']];
      if (selectedNode()) hints.push(...ACTIONS.map((a) => [a.key, a.label.replace(/[…↓ ]+$/, '').toLowerCase()]), ['Esc', 'deselect']);
      if (dryOn) hints.push(['u', 'undo'], ['y', 'apply'], ['x', 'discard'], ['p', 'steps']);
      if (S.state?.dry.redo.length) hints.push(['r', 'redo']);
      hints.push(['[', 'HISTORY'], [':', 'jj command'], ['/', 'revset'], ['f', 'fit']);
    }
    $('#hints').innerHTML = hints.map(([k, v]) => `<span><kbd>${esc(k)}</kbd> ${esc(v)}</span>`).join('');
  } else {
    if (S.mode === 'PICK') hints = ['tap the destination change or edge', 'tap empty space to cancel'];
    else if (S.mode === 'DRAG') hints = ['drop on a change or an edge', 'drop on empty space to cancel'];
    else if (S.mode === 'INPUT') hints = ['tap outside to cancel'];
    else if (S.mode === 'HISTORY') hints = ['tap a dot on the timeline to move through time', 'Back returns to now'];
    else hints = ['drag a grip to move a change', 'drag an edge to reparent', 'drag a bookmark to move it', 'tap for actions', 'tap the timeline to look back'];
    $('#hints').innerHTML = hints.map((h) => `<span>${esc(h)}</span>`).join('');
  }
}

// ---------------------------------------------------------------- feedback

let toastTimer = null;
function toast(message, { error = false, action = null, ms = error ? 7000 : 3500 } = {}) {
  const el = $('#toast');
  el.className = `show${error ? ' error' : ''}`;
  el.innerHTML = `<span>${esc(message)}</span>`;
  if (action) {
    const b = document.createElement('button');
    b.textContent = action.label;
    b.onclick = () => { el.className = ''; action.run(); };
    el.append(b);
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, ms);
}
$('#toast').addEventListener('click', (e) => { if (e.target.tagName !== 'BUTTON') $('#toast').className = ''; });

function announce(text) {
  $('#live').textContent = text;
}

function banner(text) {
  const el = $('#banner');
  el.hidden = !text;
  el.textContent = text ?? '';
}

// ---------------------------------------------------------------- sheet

let modeBeforeSheet = 'NORMAL';
function openSheet(title, body, { wide = false } = {}) {
  $('#sheetTitle').textContent = title;
  const el = $('#sheetBody');
  el.replaceChildren(...(Array.isArray(body) ? body : [body]));
  sheet.classList.toggle('wide', wide);
  if (!sheet.open) {
    modeBeforeSheet = S.mode === 'INPUT' ? 'NORMAL' : S.mode;
    sheet.showModal();
  }
  setMode('INPUT');
}
function closeSheet() {
  if (sheet.open) sheet.close();
}
sheet.addEventListener('close', () => setMode(S.pick ? 'PICK' : modeBeforeSheet === 'PICK' ? 'NORMAL' : modeBeforeSheet));
$('#sheetClose').addEventListener('click', closeSheet);
if (!('closedBy' in HTMLDialogElement.prototype)) {
  // Light dismiss where `closedby="any"` is not supported yet.
  sheet.addEventListener('click', (event) => {
    if (event.target !== sheet) return;
    const r = sheet.getBoundingClientRect();
    const inside = r.top <= event.clientY && event.clientY <= r.bottom && r.left <= event.clientX && event.clientX <= r.right;
    if (!inside) sheet.close();
  });
}

function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

/** A menu of dry-run choices, each showing the jj command it stands for. */
function openMenu(title, options, { focus = null } = {}) {
  if (!options.length) return toast('Nothing can be done with that drop.');
  const items = options.map((o, i) => {
    const b = h(`<button class="opt${i === 0 ? ' first' : ''}"><div class="t">${esc(o.title)}</div>`
      + (o.sub ? `<div class="s">${esc(o.sub)}</div>` : '')
      + (o.args ? `<code>${esc(displayCommand(o.args))}</code>` : '') + '</button>');
    b.onclick = () => {
      closeSheet();
      if (o.run) o.run();
      else dry(o.args, { focus });
    };
    return b;
  });
  openSheet(title, items);
}

function textDialog(title, { value = '', multiline = false, placeholder = '', note = '', confirm = 'Dry run' }, onSubmit) {
  const form = h(`<form class="form" method="dialog">${multiline ? '<textarea></textarea>' : '<input autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false">'}`
    + (note ? `<div class="note">${note}</div>` : '')
    + `<div class="row"><button type="button" class="ghost" data-cancel>Cancel</button><button class="primary">${esc(confirm)}</button></div></form>`);
  const input = form.firstElementChild;
  input.value = value;
  input.placeholder = placeholder;
  form.querySelector('[data-cancel]').onclick = closeSheet;
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); form.requestSubmit(); }
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    closeSheet();
    onSubmit(input.value);
  });
  openSheet(title, form);
  input.focus();
  if (!multiline) input.select();
}

function describeDialog(n) {
  textDialog(`Describe ${short(n)}`, { value: n.description.replace(/\n$/, ''), multiline: true, placeholder: 'Description' },
    (text) => dry(['describe', rev(n), '-m', text], { focus: n.change }));
}

function bookmarkDialog(n) {
  textDialog(`Bookmark on ${short(n)}`, { placeholder: 'bookmark-name', note: 'Creates the bookmark here, or moves an existing one.' }, (name) => {
    name = name.trim();
    if (name) dry(['bookmark', 'set', name, '-r', rev(n), '--allow-backwards'], { focus: n.change });
  });
}

function commandDialog() {
  textDialog('Dry-run a jj command', {
    placeholder: 'rebase -s xyz -o main',
    note: 'Runs with <code>--no-integrate-operation</code>, so it only changes the preview. Commands with effects outside the repo, such as <code>git push</code>, are refused.',
  }, (line) => { if (line.trim()) dry(line.trim()); });
}

function revsetDialog() {
  textDialog('Revset', {
    value: S.revset,
    placeholder: S.state?.defaultRevset ?? 'all()',
    note: 'Which revisions to draw. Empty uses your <code>revsets.log</code>.',
    confirm: 'Show',
  }, (value) => {
    S.revset = value.trim();
    localStorage.setItem('jj-graph.revset', S.revset);
    S.firstRender = true;
    refresh();
  });
}

function stepsSheet() {
  const d = S.state.dry;
  const list = h('<ol class="steps"></ol>');
  for (const s of d.steps) list.append(h(`<li><code>${esc(s.label)}</code>${s.output ? `<code>${esc(s.output)}</code>` : ''}</li>`));
  for (const label of [...d.redo].reverse()) list.append(h(`<li class="redo"><code>${esc(label)}</code><code>undone</code></li>`));
  const note = h('<div class="form"><div class="note">'
    + (d.stale ? `<span class="warn">${esc(d.stale)}</span> Undo steps until the rest applies, or discard. ` : '')
    + `Previewed on top of operation <code>${esc(d.base.slice(0, 12))}</code>. `
    + 'Apply runs <code>jj op integrate</code> on the last step, then updates the working copy.</div></div>');
  openSheet('Dry run', [list, note]);
}

/** A change's versions: the same change id over every commit it has been. */
async function showEvolution(n) {
  const id = short(n);
  const note = h('<div class="form"><div class="note">Loading…</div></div>');
  const list = h('<ol class="steps"></ol>');
  openSheet(`Evolution of ${id}`, [note, list]);
  try {
    const { versions } = await api(`/api/evolog?rev=${n.id}${S.at ? `&at=${S.at}` : ''}`);
    note.firstElementChild.innerHTML = `One change, ${versions.length} version${versions.length === 1 ? '' : 's'}. `
      + `Its id <b>${esc(id)}</b> never changed; jj rewrote the commit underneath each time and kept every one.`;
    versions.forEach((v, i) => list.append(h(`<li${i ? ' class="old"' : ''}><code>${esc(v.commit.slice(0, 8))} · ${ago(v.time)}${i ? '' : ' · current'}</code>`
      + `<code>${esc(v.operation ?? 'made outside jj')}</code></li>`)));
  } catch (err) {
    note.firstElementChild.textContent = err.message;
  }
}

async function showDiff(n, mode = 'stat') {
  const pre = h('<pre class="diff">Loading…</pre>');
  const more = h(`<div class="form"><div class="row"><button>${mode === 'stat' ? 'Full diff' : 'Summary'}</button></div></div>`);
  more.querySelector('button').onclick = () => showDiff(n, mode === 'stat' ? 'diff' : 'stat');
  openSheet(`${short(n)} · ${nameOf(n)}`, [pre, more], { wide: true });
  try {
    const { text } = await api(`/api/show?rev=${n.id}&mode=${mode}${S.at ? `&at=${S.at}` : ''}`);
    pre.innerHTML = text.split('\n').map((line) => {
      const cls = mode !== 'diff' ? '' : line.startsWith('@@') ? 'hunk'
        : line.startsWith('+') && !line.startsWith('+++') ? 'add'
        : line.startsWith('-') && !line.startsWith('---') ? 'del' : '';
      return cls ? `<span class="${cls}">${esc(line)}</span>` : esc(line);
    }).join('\n');
  } catch (err) {
    pre.textContent = err.message;
  }
}

// ---------------------------------------------------------------- operations

function parentRevs(n) {
  return n.parents.map((p) => (S.byId.has(p) ? rev(S.byId.get(p)) : p));
}

function nodeOnNode(x, y) {
  const X = rev(x);
  const Y = rev(y);
  const opts = [];
  if (!x.immutable) {
    opts.push({ title: 'Move here with descendants', sub: 'Rebase this change and everything on top of it.', args: ['rebase', '-s', X, '-o', Y] });
    opts.push({ title: 'Move only this change here', sub: 'Its children stay and reattach to its parents.', args: ['rebase', '-r', X, '-o', Y] });
    opts.push({ title: 'Move the whole branch here', args: ['rebase', '-b', X, '-o', Y] });
    opts.push({ title: 'Insert right after', sub: 'Between the target and its children.', args: ['rebase', '-r', X, '-A', Y] });
    if (!y.immutable) {
      opts.push({ title: 'Insert right before', sub: 'Between the target and its parents.', args: ['rebase', '-r', X, '-B', Y] });
      opts.push({ title: 'Squash into', sub: 'Fold this change\'s content into the target.', args: ['squash', '--from', X, '--into', Y] });
    }
    if (!x.parents.includes(y.id)) {
      opts.push({ title: 'Add as an extra parent', sub: 'Turn this change into a merge.', args: ['rebase', '-s', X, ...parentRevs(x).flatMap((p) => ['-o', p]), '-o', Y] });
    }
  }
  opts.push({ title: 'Duplicate onto', sub: 'Leave the original where it is.', args: ['duplicate', X, '-o', Y] });
  return opts;
}

function nodeOnEdge(x, edge) {
  const child = S.byId.get(edge.from);
  const parent = S.byId.get(edge.to);
  if (x.immutable) return [];
  return [{
    title: 'Insert between these two',
    sub: `After “${nameOf(parent)}”, before “${nameOf(child)}”.`,
    args: ['rebase', '-r', rev(x), '-A', rev(parent), '-B', rev(child)],
  }];
}

function edgeOnNode(edge, target) {
  const child = S.byId.get(edge.from);
  const next = [];
  for (const p of child.parents) {
    const r = p === edge.parent ? rev(target) : (S.byId.has(p) ? rev(S.byId.get(p)) : p);
    if (!next.includes(r)) next.push(r);
  }
  return [{
    title: 'Reparent',
    sub: `“${nameOf(child)}” swaps this parent for “${nameOf(target)}”.`,
    args: ['rebase', '-s', rev(child), ...next.flatMap((p) => ['-o', p])],
  }];
}

function edgeMenu(edge) {
  const child = S.byId.get(edge.from);
  const parent = S.byId.get(edge.to);
  if (edge.indirect) return toast('This edge skips revisions hidden by the revset.');
  if (child.immutable) return toast('Both ends of this edge are immutable.');
  const opts = [{ title: 'Insert a new change here', args: ['new', '--no-edit', '-A', rev(parent), '-B', rev(child)] }];
  if (child.parents.length > 1) {
    const rest = child.parents.filter((p) => p !== edge.parent).map((p) => (S.byId.has(p) ? rev(S.byId.get(p)) : p));
    opts.push({ title: 'Remove this parent', sub: `“${nameOf(child)}” stops merging “${nameOf(parent)}”.`, args: ['rebase', '-s', rev(child), ...rest.flatMap((p) => ['-o', p])] });
  }
  openMenu(`${short(child)} → ${short(parent)}`, opts);
}

function bookmarkMenu(name, n) {
  openMenu(`Bookmark ${name}`, [
    { title: 'Move to another change…', sub: 'Or drag the bookmark onto a change.', run: () => startPick(n, { bookmark: name }) },
    { title: 'Delete bookmark', args: ['bookmark', 'delete', name] },
  ]);
}

/** What a finished drag or pick means: source dropped on target. */
function drop(src, target) {
  if (src.type === 'bookmark') {
    if (target.type !== 'node') return;
    return dry(['bookmark', 'set', src.name, '-r', rev(target.node), '--allow-backwards'], { focus: target.node.change });
  }
  if (src.type === 'edge') {
    if (target.type !== 'node') return;
    const child = S.byId.get(src.edge.from);
    return openMenu(`Edge of ${short(child)} → ${short(target.node)}`, edgeOnNode(src.edge, target.node), { focus: child.change });
  }
  const x = src.node;
  if (target.type === 'node') return openMenu(`${short(x)} → ${short(target.node)}`, nodeOnNode(x, target.node), { focus: x.change });
  return openMenu(`${short(x)} → edge`, nodeOnEdge(x, target.edge), { focus: x.change });
}

function canDrag(what) {
  if (what.type === 'node' && what.node.immutable) return toast('That change is immutable, so it cannot move. You can still drop things onto it.'), false;
  if (what.type === 'edge') {
    if (what.edge.indirect) return toast('This edge skips revisions hidden by the revset.'), false;
    if (S.byId.get(what.edge.from).immutable) return toast('Both ends of this edge are immutable.'), false;
  }
  return true;
}

/** Nodes and edges a given source may be dropped on. */
function targetsFor(src) {
  const { edges } = S.lay;
  if (src.type === 'bookmark') return { nodes: S.rows.filter((n) => n.id !== src.node.id), edges: [] };
  if (src.type === 'edge') return { nodes: S.rows.filter((n) => n.id !== src.edge.from && n.id !== src.edge.to), edges: [] };
  const id = src.node.id;
  return {
    nodes: S.rows.filter((n) => n.id !== id),
    edges: edges.filter((e) => e.to != null && !e.indirect && e.from !== id && e.to !== id && !S.byId.get(e.from).immutable),
  };
}

// ---------------------------------------------------------------- pick mode

/** Tap-only route to everything dragging does. */
function startPick(n, { bookmark = null } = {}) {
  const src = bookmark ? { type: 'bookmark', name: bookmark, node: n } : { type: 'node', node: n };
  if (!canDrag(src)) return;
  S.pick = { node: n, src, cursor: null };
  setMode('PICK');
  banner(bookmark ? `Pick where bookmark ${bookmark} goes` : `Pick a destination for “${nameOf(n)}”`);
}

function endPick() {
  S.pick = null;
  banner(null);
  clearMarks();
  setMode('NORMAL');
}

function finishPick(target) {
  const { src } = S.pick;
  const allowed = targetsFor(src);
  const ok = target.type === 'node' ? allowed.nodes.includes(target.node) : allowed.edges.includes(target.edge);
  if (!ok) return toast('That is not a valid destination.');
  endPick();
  drop(src, target);
}

function markPickCursor() {
  clearMarks();
  if (S.pick?.cursor) mark({ type: 'node', node: S.pick.cursor });
}

// ---------------------------------------------------------------- marks

function clearMarks() {
  for (const el of document.querySelectorAll('.target, .source, .dim')) el.classList.remove('target', 'source', 'dim');
}

function mark(target) {
  if (!target) return;
  if (target.type === 'node') {
    for (const el of document.querySelectorAll(`[data-node="${target.node.id}"]`)) el.classList.add('target');
  } else {
    document.querySelector(`[data-edge-line="${CSS.escape(target.edge.key)}"]`)?.classList.add('target');
  }
}

// ---------------------------------------------------------------- gestures

const pointers = new Map();
let g = null;

const toWorld = (cx, cy) => {
  const r = vp.getBoundingClientRect();
  return [(cx - r.left - S.view.x) / S.view.k, (cy - r.top - S.view.y) / S.view.k];
};

function zoomAt(cx, cy, factor) {
  const r = vp.getBoundingClientRect();
  const k = Math.max(0.3, Math.min(2.5, S.view.k * factor));
  const f = k / S.view.k;
  const px = cx - r.left;
  const py = cy - r.top;
  S.view = { k, x: px - (px - S.view.x) * f, y: py - (py - S.view.y) * f };
  applyView();
}

function ensureEdgePoints() {
  if (S.edgePoints) return;
  S.edgePoints = new Map();
  for (const el of document.querySelectorAll('.edge-hit')) {
    const len = el.getTotalLength();
    const pts = [];
    const steps = Math.max(1, Math.ceil(len / 14));
    for (let i = 0; i <= steps; i++) {
      const p = el.getPointAtLength((len * i) / steps);
      pts.push([p.x, p.y]);
    }
    S.edgePoints.set(el.dataset.edge, pts);
  }
}

function findTarget(wx, wy, allowed) {
  const { pos } = S.lay;
  let node = null;
  let nd = 24;
  let rowNode = null;
  for (const n of allowed.nodes) {
    const p = pos.get(n.id);
    const d = Math.hypot(wx - laneX(p.lane), wy - p.y);
    if (d < nd) { nd = d; node = n; }
    const left = laneX(p.reach) + CARD_GAP - 6;
    if (Math.abs(wy - p.y) < p.h / 2 - 4 && wx >= left && wx <= left + CARD_W) rowNode = n;
  }
  if (node) return { type: 'node', node };
  let edge = null;
  let ed = 16;
  for (const e of allowed.edges) {
    const d = distanceToPolyline(wx, wy, S.edgePoints.get(e.key) ?? []);
    if (d < ed) { ed = d; edge = e; }
  }
  if (edge) return { type: 'edge', edge };
  return rowNode ? { type: 'node', node: rowNode } : null;
}

function describeHit(target) {
  const t = target.closest?.('[data-bookmark]');
  const nodeEl = target.closest?.('[data-node]');
  const node = nodeEl ? S.byId.get(nodeEl.dataset.node) : null;
  if (t && node) return { type: 'bookmark', name: t.dataset.bookmark, node };
  // A card pans the graph like empty space does; its grip moves the change.
  if (nodeEl?.classList.contains('row') && !target.closest('[data-grip]')) return { type: 'label', node };
  if (node) return { type: 'node', node };
  const edgeEl = target.closest?.('[data-edge]');
  if (edgeEl) return { type: 'edge', edge: S.lay.edges.find((e) => e.key === edgeEl.dataset.edge) };
  return { type: 'bg' };
}

function startDrag(e) {
  const src = g.what;
  ensureEdgePoints();
  const origin = S.lay.pos.get(src.type === 'edge' ? src.edge.from : src.node.id);
  Object.assign(g, { kind: 'drag', src, allowed: targetsFor(src), target: null, ox: laneX(origin.lane), oy: origin.y });
  if (src.type === 'node') {
    for (const el of document.querySelectorAll(`[data-node="${src.node.id}"]`)) el.classList.add('source');
  } else if (src.type === 'edge') {
    document.querySelector(`[data-edge-line="${CSS.escape(src.edge.key)}"]`)?.classList.add('dim');
  }
  setMode('DRAG');
  banner(src.type === 'bookmark' ? `Drop ${src.name} on a change`
    : src.type === 'edge' ? 'Drop on the new parent'
    : 'Drop on a change, or on an edge to insert');
  g.raf = requestAnimationFrame(autoPan);
  moveDrag(e.clientX, e.clientY);
}

function moveDrag(cx, cy) {
  g.cx = cx;
  g.cy = cy;
  const [wx, wy] = toWorld(cx, cy);
  const target = findTarget(wx, wy, g.allowed);
  if (target?.node !== g.target?.node || target?.edge !== g.target?.edge) {
    for (const el of document.querySelectorAll('.target')) el.classList.remove('target');
    mark(target);
    g.target = target;
    if (target && navigator.vibrate) navigator.vibrate(8);
  }
  const label = g.src.type === 'bookmark' ? `<text x="${wx + 16}" y="${wy - 14}" fill="currentColor" font-size="13" font-family="monospace">${esc(g.src.name)}</text>` : '';
  $('#overlay').innerHTML = `<path class="ghost-line" d="M${g.ox},${g.oy} L${wx},${wy}"/><circle class="ghost-dot" cx="${wx}" cy="${wy}" r="9"/>${label}`;
}

/** Scroll the graph while a drag is held near the viewport's edge. */
function autoPan() {
  if (g?.kind !== 'drag') return;
  const r = vp.getBoundingClientRect();
  const edge = 56;
  const speed = (d) => Math.ceil((1 - Math.max(0, d) / edge) * 14);
  let dx = 0;
  let dy = 0;
  if (g.cy < r.top + edge) dy = speed(g.cy - r.top);
  else if (g.cy > r.bottom - edge) dy = -speed(r.bottom - g.cy);
  if (g.cx < r.left + edge) dx = speed(g.cx - r.left);
  else if (g.cx > r.right - edge) dx = -speed(r.right - g.cx);
  // Only scroll towards graph that is actually off screen.
  const { x, y, k } = S.view;
  if (dy > 0) dy = Math.min(dy, Math.max(0, 8 - y));
  if (dy < 0) dy = Math.max(dy, Math.min(0, r.height - 8 - (y + world.offsetHeight * k)));
  if (dx > 0) dx = Math.min(dx, Math.max(0, 6 - x));
  if (dx < 0) dx = Math.max(dx, Math.min(0, r.width - 6 - (x + world.offsetWidth * k)));
  if (dx || dy) {
    S.view.x += dx;
    S.view.y += dy;
    applyView();
    moveDrag(g.cx, g.cy);
  }
  g.raf = requestAnimationFrame(autoPan);
}

function endDrag(commit) {
  const { src, target, raf } = g;
  cancelAnimationFrame(raf);
  g = null;
  $('#overlay').innerHTML = '';
  clearMarks();
  banner(null);
  setMode('NORMAL');
  if (commit && target) drop(src, target);
}

function tap(what) {
  if (S.mode === 'PICK') {
    if (what.type === 'bg') return endPick();
    if (what.type === 'edge') return finishPick({ type: 'edge', edge: what.edge });
    return finishPick({ type: 'node', node: what.node });
  }
  if (S.mode === 'HISTORY' && (what.type === 'bookmark' || what.type === 'edge')) {
    return toast('This is the past, so it is read-only. Restore to it, or go back to now, to change things.');
  }
  if (what.type === 'bookmark') return bookmarkMenu(what.name, what.node);
  if (what.type === 'edge') return edgeMenu(what.edge);
  select(what.type === 'bg' ? null : what.node.change === S.selected ? null : what.node.change);
}

function select(change) {
  S.selected = change;
  for (const el of document.querySelectorAll('.selected')) el.classList.remove('selected');
  const n = selectedNode();
  if (n) for (const el of document.querySelectorAll(`[data-node="${n.id}"]`)) el.classList.add('selected');
  renderInspector();
  renderStatus();
}

vp.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (!S.lay) return;
  vp.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) {
    if (g?.kind === 'drag') endDrag(false);
    const [a, b] = [...pointers.values()];
    g = { kind: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    return;
  }
  if (pointers.size > 2) return;
  g = { kind: 'pending', what: describeHit(e.target), sx: e.clientX, sy: e.clientY, vx: S.view.x, vy: S.view.y };
});

vp.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId) || !g) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (g.kind === 'pinch') {
    if (pointers.size < 2) return;
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    S.view.x += mx - g.mx;
    S.view.y += my - g.my;
    zoomAt(mx, my, dist / g.dist);
    Object.assign(g, { dist, mx, my });
    return;
  }
  if (g.kind === 'pending') {
    if (Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < 6) return;
    const draggable = ['node', 'edge', 'bookmark'].includes(g.what.type) && S.mode === 'NORMAL' && !S.busy;
    if (draggable && canDrag(g.what)) return startDrag(e);
    g.kind = 'pan';
    vp.classList.add('panning');
  }
  if (g.kind === 'pan') {
    S.view.x = g.vx + e.clientX - g.sx;
    S.view.y = g.vy + e.clientY - g.sy;
    applyView();
  } else if (g.kind === 'drag') {
    moveDrag(e.clientX, e.clientY);
  }
});

function pointerEnd(e, cancelled) {
  if (!pointers.delete(e.pointerId) || !g) return;
  vp.classList.remove('panning');
  if (g.kind === 'pinch') {
    // One finger left: carry on as a pan from where it is.
    const rest = [...pointers.values()][0];
    g = rest ? { kind: 'pan', sx: rest.x, sy: rest.y, vx: S.view.x, vy: S.view.y } : null;
    return;
  }
  if (g.kind === 'drag') return endDrag(!cancelled);
  const what = g.kind === 'pending' && !cancelled ? g.what : null;
  g = null;
  if (what) tap(what);
}
vp.addEventListener('pointerup', (e) => pointerEnd(e, false));
vp.addEventListener('pointercancel', (e) => pointerEnd(e, true));

vp.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01));
  else {
    S.view.x -= e.deltaX;
    S.view.y -= e.deltaY;
    applyView();
  }
}, { passive: false });

function ensureVisible(id) {
  const p = S.lay.pos.get(id);
  if (!p) return;
  const y = p.y * S.view.k + S.view.y;
  const h = vp.clientHeight;
  if (y < 40) S.view.y += 80 - y;
  else if (y > h - 40) S.view.y -= y - (h - 80);
  applyView();
}

function fit() {
  if (!S.lay) return;
  const w = parseFloat(svg.getAttribute('width'));
  const k = Math.max(0.45, Math.min(1, vp.clientWidth / w));
  S.view = { x: 6, y: 8, k };
  applyView();
}

// ---------------------------------------------------------------- buttons

$('#planbar').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'apply') applyPlan();
  else if (act === 'discard') post('/api/discard');
  else if (act === 'undo') post('/api/undo');
  else if (act === 'redo') post('/api/redo');
  else if (act === 'steps') stepsSheet();
  else if (act === 'now') travel(null);
  else if (act === 'restore') restoreHere();
});

$('#timeline').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.op) travel(b.dataset.op);
  else post('/api/goto', { steps: Number(b.dataset.step) });
});

$('#inspector').addEventListener('click', (e) => {
  const key = e.target.closest('[data-action]')?.dataset.action;
  const n = selectedNode();
  const action = ACTIONS.find((a) => a.key === key);
  if (action && n && allowed(action, n)) action.run(n);
});

async function jjrSheet() {
  const note = h('<div class="form"><div class="note">Loading jjr diagnostics &amp; Jev triage…</div></div>');
  openSheet('jjr Framework', [note]);
  try {
    const target = selectedNode() ?? S.rows.find((n) => n.wc) ?? S.rows.find((n) => !n.immutable);
    const [diag, triage, naming] = await Promise.all([
      api(`/api/jjr/diagnose?revset=${encodeURIComponent(S.revset)}${S.at ? `&at=${S.at}` : ''}`),
      target ? api('/api/jjr/triage', { rev: target.change, revset: S.revset || 'all()' }) : null,
      target ? api('/api/jjr/suggest-name', { rev: target.change, revset: S.revset || 'all()' }) : null,
    ]);

    const body = h('<div class="form"></div>');
    body.append(h(`<div class="note"><b>${esc(diag.summary.status.toUpperCase())}</b> · ${diag.summary.mutableCount} mutable · ${diag.summary.mutableRootsCount} root(s) · Jev: <code>${esc(diag.jevMode)}</code> · <a href="/docs" target="_blank">Read jjr Docs ↗</a></div>`));
    body.append(h(`<div class="note">${esc(diag.feedback.summary)}</div>`));

    if (diag.diagnostics.length) {
      const list = h('<ol class="steps"></ol>');
      for (const d of diag.diagnostics) {
        const li = h(`<li><div><b>${esc(d.code)}</b> (${esc(d.severity)})</div><div class="s">${esc(d.message)}</div>${d.suggestedCommand ? `<code>${esc(d.suggestedCommand)}</code>` : ''}</li>`);
        if (d.suggestedArgs) {
          const btn = h('<button type="button" class="primary" style="margin-top:6px">Dry-run fix</button>');
          btn.onclick = () => { closeSheet(); dry(d.suggestedArgs); };
          li.append(btn);
        }
        list.append(li);
      }
      body.append(list);
    }

    if (triage && target) {
      const a = triage.answers;
      body.append(h(`<div class="note"><b>Jev Triage (${esc(short(target))})</b><br>`
        + `Intent: <code>${esc(a.intent.choice)}</code> (conf ${a.intent.confidence.toFixed(2)}) · `
        + `Entangled: <code>p=${a.entangled.noul.toFixed(2)}</code> · `
        + `Readiness: <code>${esc(a.publishReadiness.legend)}</code> (${a.publishReadiness.score.toFixed(2)}) · `
        + `Debug/Secrets: <code>p=${a.hasDebugOrSecrets.noul.toFixed(2)}</code></div>`));
    }

    if (naming && target && !target.immutable) {
      const box = h(`<div class="note"><b>Suggested description (${esc(naming.source)})</b><br><code>${esc(naming.conventionalTitle)}</code><br>${esc(naming.rationale)}</div>`);
      const applyName = h('<button type="button" class="ghost" style="margin-top:6px">Dry-run describe</button>');
      applyName.onclick = () => { closeSheet(); dry(['describe', rev(target), '-m', naming.conventionalTitle], { focus: target.change }); };
      box.append(applyName);
      body.append(box);
    }

    $('#sheetBody').replaceChildren(body);
  } catch (err) {
    note.firstElementChild.textContent = err.message;
  }
}

$('#revsetBtn').addEventListener('click', revsetDialog);
$('#jjrBtn').addEventListener('click', jjrSheet);
$('#cmdBtn').addEventListener('click', commandDialog);
$('#fitBtn').addEventListener('click', fit);

// ---------------------------------------------------------------- keyboard

function moveSelection(delta) {
  if (!S.rows.length) return;
  if (S.mode === 'PICK') {
    const allowed = targetsFor(S.pick.src).nodes;
    // Start from the row being moved, so the first press lands next to it.
    const from = S.rows.indexOf(S.pick.cursor ?? S.pick.node);
    const ordered = delta > 0 ? S.rows.slice(from + 1) : S.rows.slice(0, Math.max(from, 0)).reverse();
    const next = ordered.find((n) => allowed.includes(n));
    if (!next) return;
    S.pick.cursor = next;
    markPickCursor();
    return ensureVisible(S.pick.cursor.id);
  }
  const i = S.rows.findIndex((n) => n.change === S.selected);
  const next = S.rows[Math.max(0, Math.min(S.rows.length - 1, i === -1 ? 0 : i + delta))];
  select(next.change);
  ensureVisible(next.id);
}

document.addEventListener('keydown', (e) => {
  if (!S.keyboard) {
    S.keyboard = true;
    renderStatus();
  }
  if (sheet.open || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.matches?.('input, textarea')) return;
  const key = e.key;
  if (S.mode === 'DRAG') {
    if (key === 'Escape') endDrag(false);
    return;
  }
  if (key === 'j' || key === 'ArrowDown') { e.preventDefault(); return moveSelection(1); }
  if (key === 'k' || key === 'ArrowUp') { e.preventDefault(); return moveSelection(-1); }
  if (S.mode === 'PICK') {
    if (key === 'Escape' || key === 'm') endPick();
    else if (key === 'Enter' && S.pick.cursor) finishPick({ type: 'node', node: S.pick.cursor });
    return;
  }
  const n = selectedNode();
  const action = ACTIONS.find((a) => a.key === key);
  if (action && n) {
    e.preventDefault();
    if (!allowed(action, n)) return toast(S.mode === 'HISTORY' ? 'The past is read-only.' : 'That change is immutable.');
    return action.run(n);
  }
  if (!S.state) return;
  if (key === '[') return stepHistory(-1);
  if (key === ']') return stepHistory(1);
  if (S.mode === 'HISTORY') {
    if (key === 'Escape') travel(null);
    else if (key === 'Enter' && S.at !== S.state.ops[0]?.id) restoreHere();
    return;
  }
  const dryOn = S.state?.dry.active;
  if (key === 'Escape') select(null);
  else if (key === ':') { e.preventDefault(); commandDialog(); }
  else if (key === '/') { e.preventDefault(); revsetDialog(); }
  else if (key === 'f') fit();
  else if (key === 'u' && dryOn) post('/api/undo');
  else if (key === 'r' && S.state?.dry.redo.length) post('/api/redo');
  else if (key === 'x' && dryOn) post('/api/discard');
  else if (key === 'y' && dryOn) applyPlan();
  else if (key === 'p' && dryOn) stepsSheet();
});

fineKeyboard.addEventListener('change', () => {
  S.keyboard = fineKeyboard.matches;
  renderStatus();
});

// ---------------------------------------------------------------- start

setInterval(() => {
  if (document.visibilityState === 'visible' && !g && !sheet.open && !S.busy && ['NORMAL', 'HISTORY'].includes(S.mode)) refresh({ quiet: true });
}, 4000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh({ quiet: true }); });

renderStatus();
refresh();
