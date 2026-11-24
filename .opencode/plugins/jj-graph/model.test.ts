import { describe, expect, test } from "bun:test"
import { diagnosticRows, graphRows, lanes, planRows, summarize, summaryLines, type Node, type State } from "./model"

const id = (n: number) => String(n).repeat(40)
const change = (c: string) => c.repeat(32)

function node(n: number, c: string, parents: number[], extra: Partial<Node> = {}): Node {
  return {
    change: change(c),
    id: id(n),
    prefix: c,
    description: `rev ${n}\n`,
    author: "a",
    time: "2026-01-01T00:00:00Z",
    wc: false,
    conflict: false,
    divergent: false,
    empty: false,
    hidden: false,
    immutable: false,
    files: 1,
    paths: [`f${n}`],
    bookmarks: [],
    remotes: [],
    tags: [],
    workspaces: [],
    edges: parents.map((p) => ({ to: id(p), parent: id(p), indirect: false })),
    parents: parents.map(id),
    ...extra,
  }
}

function state(nodes: Node[], extra: Partial<State> = {}): State {
  return {
    repo: "/r",
    revset: "all()",
    defaultRevset: "all()",
    head: "f".repeat(128),
    viewing: null,
    truncated: false,
    nodes,
    ops: [],
    baseline: null,
    touched: [],
    rewound: false,
    jjr: {
      summary: { shape: "stack", status: "clean", mutableCount: nodes.length, conflictedCount: 0, divergentCount: 0 },
      diagnostics: [],
      verification: {},
    },
    dry: { active: false, base: null, stale: null, steps: [], redo: [] },
    ...extra,
  }
}

// Two arms on one base: 3 (@) and 2 are both children of 1.
const arms = [node(3, "m", [1], { wc: true }), node(2, "n", [1]), node(1, "o", [9]), node(9, "z", [], { immutable: true })]

describe("lanes", () => {
  test("a linear stack stays in one lane", () => {
    const lines = lanes([node(2, "m", [1]), node(1, "n", [])])
    expect(lines).toEqual([
      { before: "", after: "" },
      { before: "", after: "" },
    ])
  })

  test("a second arm takes a lane, and its line passes the first arm's rows", () => {
    const lines = lanes(arms)
    // 3 is first, in lane 0; 2 sits in lane 1 while 3's line to 1 runs down lane 0.
    expect(lines[0].before).toBe("")
    expect(lines[1].before).toBe("│ ")
    expect(lines[2].before).toBe("")
  })
})

describe("summary", () => {
  test("names the working copy and reads an open plan as busy", () => {
    const s = summarize(
      state(arms, {
        dry: { active: true, base: "b", stale: null, steps: [{ label: "jj rebase -s m -o n", output: "" }], redo: [] },
      }),
    )
    expect(s.workingCopy?.title).toBe("rev 3")
    expect(s.plan.steps).toEqual(["jj rebase -s m -o n"])
    expect(s.tone).toBe("busy")
    const lines = summaryLines(s)
    expect(lines.map((l) => l.key)).toEqual(["wc", "stack", "plan", "jjr"])
    expect(lines[2].text).toContain("1 step")
  })

  test("a stale plan warns and a conflict is an error", () => {
    expect(
      summarize(state(arms, { dry: { active: true, base: "b", stale: "step 1 no longer applies", steps: [], redo: [] } }))
        .tone,
    ).toBe("warn")
    expect(summarize(state([node(1, "m", [], { wc: true, conflict: true })])).tone).toBe("error")
  })
})

describe("rows", () => {
  test("the graph marks what the plan edited, what followed, and what it created", () => {
    const s = state(arms, {
      touched: [change("m")],
      baseline: { [change("m")]: id(7), [change("n")]: id(8), [change("o")]: id(1), [change("z")]: id(9) },
    })
    const rows = graphRows(s)
    expect(rows[0].glyph).toBe("@")
    expect(rows[0].detail).toContain("edited by plan")
    expect(rows[0].tone).toBe("busy")
    expect(rows[1].detail).toContain("auto-rebased")
    expect(rows[3].glyph).toBe("◆")
    expect(rows[0].lines[0]).toBe(`change ${change("m")}`)
    expect(graphRows(state(arms, { baseline: {} }))[0].detail).toContain("new")
  })

  test("the plan lists a stale step first and redo steps last", () => {
    const rows = planRows(
      state(arms, {
        dry: { active: true, base: "b", stale: "gone", steps: [{ label: "jj new", output: "Created" }], redo: ["jj abandon"] },
      }),
    )
    expect(rows.map((r) => r.key)).toEqual(["stale", "step-0", "redo-0"])
    expect(rows[1].lines).toContain("Created")
  })

  test("a diagnostic copies its fix", () => {
    const rows = diagnosticRows(
      state(arms, {
        jjr: {
          summary: { shape: "stack", status: "attention", mutableCount: 3, conflictedCount: 0, divergentCount: 0 },
          diagnostics: [{ code: "DEEP_STACK", severity: "warning", message: "deep", suggestedCommand: "jj squash" }],
          verification: {},
        },
      }),
    )
    expect(rows[0].tone).toBe("warn")
    expect(rows[0].copy).toBe("jj squash")
  })
})
