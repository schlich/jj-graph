import assert from 'node:assert/strict';
import test from 'node:test';
import { distanceToPolyline, edgePath, layout } from '../public/layout.js';

const node = (id, ...parents) => ({ id, edges: parents.map((p) => ({ to: p, parent: p, indirect: false })) });

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

test('distance to a polyline', () => {
  assert.equal(distanceToPolyline(5, 3, [[0, 0], [10, 0]]), 3);
  assert.equal(distanceToPolyline(13, 4, [[0, 0], [10, 0]]), 5);
});
