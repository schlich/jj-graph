// Pure DAG layout: rows top-down in jj's log order (children before
// parents), one lane per line of development, the same shape `jj log` draws.

export const ROW = 66;
export const LANE = 22;
export const PAD = 20;
const BEND = 26; // vertical room an edge takes to change lanes

/**
 * @param {{id: string, edges: {to: string|null, parent: string, indirect: boolean}[]}[]} nodes
 * @param {(node: object) => number} heightOf row height per node, so rows
 *   that matter less can be drawn smaller
 * @returns {{
 *   pos: Map<string, {row: number, lane: number, reach: number, y: number, h: number}>,
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
    const h = heightOf(node);
    pos.set(node.id, { row, lane, reach, y: bottom + h / 2, h });
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
  if (edge.to == null) return `M${x1},${y1} L${x1},${y1 + a.h * 0.45}`;
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
