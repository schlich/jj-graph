import assert from 'node:assert/strict';
import test from 'node:test';
import { distanceToPolyline, edgePath, layout, stackChanges } from '../public/layout.js';

const node = (id, ...parents) => ({ id, edges: parents.map((p) => ({ to: p, parent: p, indirect: false })) });
const changeNode = (id, change, parents = [], extra = {}) => ({
  id,
  change,
  edges: parents.map((p) => (typeof p === 'string' ? { to: p, parent: p, indirect: false } : p)),
  ...extra,
});

test('a linear history stays in one lane', () => {
  const { pos, lanes } = layout([node('c', 'b'), node('b', 'a'), node('a')]);
  assert.equal(lanes, 1);
  assert.deepEqual([...pos.values()].map((p) => [p.row, p.lane]), [[0, 0], [1, 0], [2, 0]]);
});

test('siblings get their own lanes and join at the shared parent', () => {
  const { pos, edges, lanes } = layout([node('x', 'base'), node('y', 'base'), node('base')]);
  assert.equal(lanes, 2);
  assert.equal(pos.get('x').lane, 0);
  assert.equal(pos.get('y').lane, 1);
  assert.equal(pos.get('base').lane, 0);
  assert.deepEqual(edges.map((e) => e.track), [0, 0]);
  assert.equal(pos.get('y').reach, 1);
});

test('a merge opens a second lane that closes at the other parent', () => {
  const { pos, edges } = layout([node('m', 'a', 'b'), node('a', 'root'), node('b', 'root'), node('root')]);
  assert.equal(pos.get('a').lane, 0);
  assert.equal(pos.get('b').lane, 1);
  assert.equal(pos.get('root').lane, 0);
  assert.deepEqual(edges.filter((e) => e.from === 'm').map((e) => e.track), [0, 1]);
  assert.equal(pos.get('b').reach, 1);
  assert.equal(pos.get('root').reach, 0);
});

test('the leftmost line runs straight into a parent a side branch reached first', () => {
  // side -> base opens lane 1 before the main line (lane 0) reaches base.
  const { pos, edges } = layout([node('top', 'mid'), node('side', 'base'), node('mid', 'base'), node('base')]);
  assert.equal(pos.get('side').lane, 1);
  assert.equal(pos.get('base').lane, 0);
  assert.equal(edges.find((e) => e.from === 'mid').track, 0);
  assert.equal(edges.find((e) => e.from === 'side').track, 1);
});

test('lanes are reused once a branch ends', () => {
  const { pos } = layout([node('x', 'base'), node('y', 'base'), node('base', 'old'), node('z', 'old'), node('old')]);
  assert.equal(pos.get('z').lane, 1);
});

test('a parent outside the set becomes a stub and reserves nothing', () => {
  const { edges, lanes } = layout([{ id: 'a', edges: [{ to: null, parent: 'gone', indirect: true }] }, node('b')]);
  assert.equal(lanes, 1);
  assert.equal(edges[0].to, null);
});

test('every edge has a drawable path', () => {
  const nodes = [node('m', 'a', 'b'), node('a', 'root'), node('c', 'root'), node('b', 'root'), node('root')];
  const { pos, edges } = layout(nodes);
  for (const e of edges) assert.match(edgePath(e, pos), /^M[\d.]+,[\d.]+ [LC]/);
});

test('rows can have their own heights', () => {
  const nodes = [node('a', 'b'), node('b', 'c'), node('c')];
  const { pos, height } = layout(nodes, (n) => (n.id === 'c' ? 30 : 60));
  assert.deepEqual([...pos.values()].map((p) => p.h), [60, 60, 30]);
  assert.equal(pos.get('b').y - pos.get('a').y, 60);
  assert.equal(pos.get('c').y - pos.get('b').y, 45);
  assert.ok(height > pos.get('c').y + 15);
});

test('rows can anchor the node dot near the top of an expanded stack', () => {
  const nodes = [node('a', 'b'), node('b')];
  const { pos, height } = layout(nodes, (n) => (n.id === 'a' ? { height: 180, anchor: 33 } : 66));
  assert.equal(pos.get('a').y, pos.get('a').top + 33);
  assert.equal(pos.get('b').top, pos.get('a').top + 180);
  assert.equal(pos.get('b').y, pos.get('b').top + 33);
  assert.ok(height > pos.get('b').y + 33);
});

test('stackChanges collapses commits with the same change id to the latest commit', () => {
  const nodes = [
    changeNode('c_old', 'chg_x', ['base'], { time: '2026-01-01T00:00:00Z', divergent: true }),
    changeNode('c_new', 'chg_x', ['base'], { time: '2026-01-02T00:00:00Z', divergent: true }),
    changeNode('base', 'chg_base', []),
  ];
  const stacked = stackChanges(nodes);
  assert.deepEqual(stacked.map((n) => n.id), ['c_new', 'base']);
  assert.equal(stacked[0].stackTotal, 2);
  assert.equal(stacked[0].stackExpanded, false);
  assert.deepEqual(stacked[0].stackNodes.map((n) => n.id), ['c_new', 'c_old']);
  // Edges from both commits are deduplicated to one edge to base.
  assert.equal(stacked[0].edges.length, 1);
  assert.equal(stacked[0].edges[0].to, 'base');
});

test('stackChanges prefers visible commits over hidden predecessors even if timestamps tie', () => {
  const nodes = [
    changeNode('c_hidden', 'chg_x', ['base'], { hidden: true, time: '2026-01-03T00:00:00Z' }),
    changeNode('c_vis', 'chg_x', ['base'], { hidden: false, time: '2026-01-01T00:00:00Z' }),
    changeNode('base', 'chg_base', []),
  ];
  const stacked = stackChanges(nodes);
  assert.deepEqual(stacked.map((n) => n.id), ['c_vis', 'base']);
  assert.deepEqual(stacked[0].stackNodes.map((n) => n.id), ['c_vis', 'c_hidden']);
});

test('stackChanges remaps child edges to the collapsed head and preserves topological order', () => {
  const nodes = [
    changeNode('c_new', 'chg_x', ['base'], { time: '2026-01-02T00:00:00Z' }),
    changeNode('child_of_old', 'chg_child', ['c_old']),
    changeNode('c_old', 'chg_x', ['base'], { time: '2026-01-01T00:00:00Z' }),
    changeNode('base', 'chg_base', []),
  ];
  const stacked = stackChanges(nodes);
  assert.deepEqual(stacked.map((n) => n.id), ['child_of_old', 'c_new', 'base']);
  assert.deepEqual(stacked[0].edges.map((e) => e.to), ['c_new']);
  // Layout stays clean with no dangling lanes.
  const { lanes } = layout(stacked);
  assert.equal(lanes, 1);
});

test('stackChanges removes self-loops and prefers direct edges when deduplicating', () => {
  const nodes = [
    changeNode('c_new', 'chg_x', ['c_old', { to: 'base', parent: 'p', indirect: true }], { time: '2026-01-02T00:00:00Z' }),
    changeNode('c_old', 'chg_x', [{ to: 'base', parent: 'base', indirect: false }], { time: '2026-01-01T00:00:00Z' }),
    changeNode('base', 'chg_base', []),
  ];
  const stacked = stackChanges(nodes);
  assert.equal(stacked[0].edges.length, 1);
  assert.equal(stacked[0].edges[0].to, 'base');
  assert.equal(stacked[0].edges[0].indirect, false);
});

test('stackChanges expands duplicate change commits back into the DAG when expanded', () => {
  const nodes = [
    changeNode('c_new', 'chg_x', ['base'], { time: '2026-01-02T00:00:00Z' }),
    changeNode('c_old', 'chg_x', ['base'], { time: '2026-01-01T00:00:00Z' }),
    changeNode('base', 'chg_base', []),
  ];
  const expanded = stackChanges(nodes, new Set(['chg_x']));
  assert.deepEqual(expanded.map((n) => n.id), ['c_new', 'c_old', 'base']);
  assert.equal(expanded[0].stackExpanded, true);
  assert.equal(expanded[0].stackIndex, 0);
  assert.equal(expanded[1].stackExpanded, true);
  assert.equal(expanded[1].stackIndex, 1);
  assert.equal(expanded[1].stackHeadId, 'c_new');
});

test('stackChanges preserves evolog version counts on single-commit changes', () => {
  const nodes = [
    changeNode('c1', 'chg_x', ['base'], { versions: 4 }),
    changeNode('base', 'chg_base', [], { versions: 1 }),
  ];
  const collapsed = stackChanges(nodes);
  assert.equal(collapsed[0].stackTotal, 4);
  assert.equal(collapsed[0].stackExpanded, false);
  const expanded = stackChanges(nodes, new Set(['chg_x']));
  assert.equal(expanded[0].stackTotal, 4);
  assert.equal(expanded[0].stackExpanded, true);
});

test('distance to a polyline', () => {
  assert.equal(distanceToPolyline(5, 3, [[0, 0], [10, 0]]), 3);
  assert.equal(distanceToPolyline(13, 4, [[0, 0], [10, 0]]), 5);
});
