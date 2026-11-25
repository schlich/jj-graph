// Pure DAG layout: rows top-down in jj's log order (children before
// parents), one lane per line of development, the same shape `jj log` draws.

export const ROW = 66;
export const LANE = 22;
export const PAD = 20;
const BEND = 26; // vertical room an edge takes to change lanes

function compareLatest(a, b) {
  if (Boolean(a.hidden) !== Boolean(b.hidden)) return a.hidden ? 1 : -1;
  const ta = a.time ? Date.parse(a.time) : NaN;
  const tb = b.time ? Date.parse(b.time) : NaN;
  if (!Number.isNaN(ta) && !Number.isNaN(tb) && ta !== tb) return tb - ta;
  if (Boolean(a.wc) !== Boolean(b.wc)) return a.wc ? -1 : 1;
  return 0;
}

/**
 * Group commits sharing the same jj `change` id so that collapsed changesets
 * render as a single stacked card (the latest commit), with edges from and to
 * tucked commits remapped onto the head commit. Expanded changesets emit all
 * member commits present in `nodes` with their real DAG edges.
 *
 * @param {object[]} nodes
 * @param {Set<string>} [expanded] change ids whose stacks are expanded
 * @returns {object[]}
 */
export function stackChanges(nodes, expanded = new Set()) {
  const groups = new Map();
  const origIndex = new Map();
  nodes.forEach((n, i) => {
    origIndex.set(n.id, i);
    const key = n.change || n.id;
    let g = groups.get(key);
    if (!g) {
      g = [];
      groups.set(key, g);
    }
    g.push(n);
  });

  const repById = new Map();
  const groupMeta = new Map();
  for (const [key, members] of groups) {
    const ordered = members.length > 1 ? [...members].sort(compareLatest) : members;
    const head = ordered[0];
    const total = Math.max(ordered.length, ...ordered.map((m) => m.versions || 1));
    const isExpanded = expanded.has(key) && total > 1;
    groupMeta.set(key, { ordered, head, total, isExpanded });
    for (const m of ordered) {
      repById.set(m.id, isExpanded ? m.id : head.id);
    }
  }

  const emitted = [];
  const seenHead = new Set();
  for (const n of nodes) {
    const key = n.change || n.id;
    const meta = groupMeta.get(key);
    if (meta.isExpanded) {
      const idx = meta.ordered.indexOf(n);
      emitted.push({
        ...n,
        stackKey: key,
        stackNodes: meta.ordered,
        stackHeadId: meta.head.id,
        stackIndex: idx,
        stackTotal: meta.total,
        stackExpanded: true,
        edges: remapEdges(n.edges ?? [], n.id, repById),
      });
    } else if (!seenHead.has(key)) {
      seenHead.add(key);
      const allEdges = meta.ordered.flatMap((m) => m.edges ?? []);
      emitted.push({
        ...meta.head,
        divergent: meta.head.divergent || meta.ordered.some((m) => m.divergent),
        stackKey: key,
        stackNodes: meta.ordered,
        stackHeadId: meta.head.id,
        stackIndex: 0,
        stackTotal: meta.total,
        stackExpanded: false,
        edges: remapEdges(allEdges, meta.head.id, repById),
      });
    }
  }

  // Re-establish topological order (children before parents) if collapsing
  // merged commits from different rows, preserving original order on ties.
  const out = topoOrder(emitted, origIndex);
  const rowOf = new Map(out.map((n, i) => [n.id, i]));
  for (const n of out) {
    const srcRow = rowOf.get(n.id);
    n.edges = n.edges.filter((e) => e.to == null || (rowOf.has(e.to) && rowOf.get(e.to) > srcRow));
  }
  return out;
}

function remapEdges(rawEdges, selfId, repById) {
  const byTarget = new Map();
  const order = [];
  for (const e of rawEdges) {
    const to = e.to != null ? (repById.get(e.to) ?? e.to) : null;
    if (to === selfId) continue;
    const dedupKey = to != null ? `to:${to}` : `stub:${e.parent}`;
    const existing = byTarget.get(dedupKey);
    if (!existing) {
      const copy = { ...e, to };
      byTarget.set(dedupKey, copy);
      order.push(dedupKey);
    } else if (existing.indirect && !e.indirect) {
      existing.indirect = false;
      existing.parent = e.parent;
    }
  }
  return order.map((k) => byTarget.get(k));
}

function topoOrder(nodes, origIndex) {
  if (nodes.length <= 1) return nodes;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  for (const n of nodes) {
    for (const e of n.edges) {
      if (e.to != null && byId.has(e.to)) {
        indeg.set(e.to, indeg.get(e.to) + 1);
      }
    }
  }
  const ready = nodes.filter((n) => indeg.get(n.id) === 0);
  const rank = (n) => origIndex.get(n.id) ?? 0;
  ready.sort((a, b) => rank(a) - rank(b));

  const out = [];
  const placed = new Set();
  while (ready.length) {
    const cur = ready.shift();
    if (placed.has(cur.id)) continue;
    placed.add(cur.id);
    out.push(cur);
    for (const e of cur.edges) {
      if (e.to == null || !byId.has(e.to) || placed.has(e.to)) continue;
      const nextDeg = indeg.get(e.to) - 1;
      indeg.set(e.to, nextDeg);
      if (nextDeg === 0) {
        const target = byId.get(e.to);
        const r = rank(target);
        let ins = ready.length;
        for (let i = 0; i < ready.length; i++) {
          if (rank(ready[i]) > r) { ins = i; break; }
        }
        ready.splice(ins, 0, target);
      }
    }
  }
  if (out.length < nodes.length) {
    for (const n of nodes) if (!placed.has(n.id)) out.push(n);
  }
  return out;
}

/**
 * @param {{id: string, edges: {to: string|null, parent: string, indirect: boolean}[]}[]} nodes
 * @param {(node: object) => (number | {height: number, anchor?: number})} heightOf row height
 *   (or `{ height, anchor }` where `anchor` is the node dot's offset from the row top)
 * @returns {{
 *   pos: Map<string, {row: number, lane: number, reach: number, y: number, h: number, top: number, anchor: number}>,
 *   edges: {key: string, from: string, to: string|null, parent: string, indirect: boolean, track: number}[],
 *   lanes: number,
 *   height: number,
 * }}
 * `reach` is the rightmost lane in use on that row, so a card can sit
 * beside it. `track` is the lane an edge runs down between its two ends.
 */
export function layout(nodes, heightOf = () => ROW) {
  const lanes = []; // lane -> id of the commit that lane is waiting for
  const pos = new Map();
  const edges = [];
  let width = 0;
  let bottom = PAD / 2;

  const firstFree = (from = 0) => {
    for (let i = from; i < lanes.length; i++) if (lanes[i] == null) return i;
    lanes.push(null);
    return lanes.length - 1;
  };
  const rightmost = () => {
    for (let i = lanes.length - 1; i >= 0; i--) if (lanes[i] != null) return i;
    return -1;
  };

  nodes.forEach((node, row) => {
    const waiting = [];
    lanes.forEach((id, i) => { if (id === node.id) waiting.push(i); });
    const lane = waiting.length ? waiting[0] : firstFree();
    let reach = Math.max(rightmost(), lane);
    for (const i of waiting) lanes[i] = null;

    let ownLaneTaken = false;
    for (const e of node.edges) {
      let track = lane;
      if (e.to != null) {
        const existing = lanes.indexOf(e.to);
        const ownFree = !ownLaneTaken && lanes[lane] == null;
        // Join a lane another child already opened, unless this node sits
        // to its left: then run straight down so the main line stays put
        // and the other lane curves in.
        if (existing !== -1 && !(ownFree && existing > lane)) {
          track = existing;
        } else if (ownFree) {
          track = lane; // continue straight down
          lanes[lane] = e.to;
          ownLaneTaken = true;
        } else {
          track = firstFree(lane + 1);
          lanes[track] = e.to;
        }
      }
      edges.push({
        key: `${node.id}>${e.parent}>${e.to ?? ''}`,
        from: node.id,
        to: e.to,
        parent: e.parent,
        indirect: e.indirect,
        track,
      });
    }
    reach = Math.max(reach, rightmost());
    width = Math.max(width, reach + 1);
    const raw = heightOf(node);
    const h = typeof raw === 'number' ? raw : raw.height;
    const anchor = typeof raw === 'number' ? h / 2 : (raw.anchor ?? h / 2);
    pos.set(node.id, { row, lane, reach, y: bottom + anchor, h, top: bottom, anchor });
    bottom += h;
  });

  return { pos, edges, lanes: Math.max(width, 1), height: bottom + PAD / 2 };
}

export const laneX = (lane) => PAD + lane * LANE;

/** SVG path for an edge, child (above) to parent (below). */
export function edgePath(edge, pos) {
  const a = pos.get(edge.from);
  const x1 = laneX(a.lane);
  const y1 = a.y;
  if (edge.to == null) return `M${x1},${y1} L${x1},${y1 + Math.min(a.h, ROW) * 0.45}`;
  const b = pos.get(edge.to);
  const x2 = laneX(b.lane);
  const y2 = b.y;
  const xt = laneX(edge.track);
  const top = y1 + BEND;
  const bottom = y2 - BEND;
  if (bottom < top || (xt === x1 && xt === x2)) {
    if (x1 === x2) return `M${x1},${y1} L${x2},${y2}`;
    const mid = (y1 + y2) / 2;
    return `M${x1},${y1} C${x1},${mid} ${x2},${mid} ${x2},${y2}`;
  }
  let d = `M${x1},${y1}`;
  d += xt === x1 ? ` L${xt},${top}` : ` C${x1},${y1 + BEND * 0.6} ${xt},${y1 + BEND * 0.4} ${xt},${top}`;
  if (bottom > top) d += ` L${xt},${bottom}`;
  d += xt === x2 ? ` L${x2},${y2}` : ` C${xt},${bottom + BEND * 0.6} ${x2},${bottom + BEND * 0.4} ${x2},${y2}`;
  return d;
}

/** Distance from a point to a polyline given as [[x, y], ...]. */
export function distanceToPolyline(px, py, points) {
  let best = Infinity;
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1];
    const [bx, by] = points[i];
    const dx = bx - ax;
    const dy = by - ay;
    const len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
    best = Math.min(best, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)));
  }
  return best;
}
