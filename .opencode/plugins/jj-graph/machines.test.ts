import { describe, expect, test } from "bun:test"
import { createActor, SimulatedClock } from "xstate"
import type { State } from "./model"
import { backoff, changed, connect, published, RETRIES, type SourceClient } from "./source.machine"
import { badge, bindings, hints, selectedKey, viewMachine, type Rows, type Surface } from "./view.machine"

// Settle the promise callbacks the read actor chains on a client's answer.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function graph(head: string): State {
  return {
    repo: "/r",
    revset: "all()",
    defaultRevset: "all()",
    head,
    viewing: null,
    truncated: false,
    nodes: [],
    ops: [],
    baseline: null,
    touched: [],
    rewound: false,
    jjr: {
      summary: { shape: "single", status: "clean", mutableCount: 0, conflictedCount: 0, divergentCount: 0 },
      diagnostics: [],
      verification: {},
    },
    dry: { active: false, base: null, stale: null, steps: [], redo: [] },
  }
}

/** A client whose reads are answered by the test, in any order. */
function controlledClient() {
  const reads: { signal: AbortSignal; answer(state: State): void; fail(error: unknown): void }[] = []
  let inFlight = 0
  let mostInFlight = 0
  let refreshes = 0
  const client: SourceClient = {
    state: (signal) =>
      new Promise<State>((resolve, reject) => {
        inFlight++
        mostInFlight = Math.max(mostInFlight, inFlight)
        const done = () => inFlight--
        signal.addEventListener("abort", done, { once: true })
        reads.push({
          signal,
          answer: (state) => {
            if (!signal.aborted) done()
            resolve(state)
          },
          fail: (error) => {
            if (!signal.aborted) done()
            reject(error)
          },
        })
      }),
    refresh: async () => {
      refreshes++
    },
  }
  return { client, reads, mostInFlight: () => mostInFlight, refreshes: () => refreshes }
}

const booting = { type: "rpc.unavailable" }

describe("graph source", () => {
  test("reads on start and shows what it read", async () => {
    const { client, reads } = controlledClient()
    const source = createActor(connect(client)).start()
    expect(source.getSnapshot().matches("loading")).toBe(true)
    reads[0].answer(graph("a"))
    await settle()
    expect(source.getSnapshot().matches("ready")).toBe(true)
    expect(source.getSnapshot().context.state?.head).toBe("a")
    expect(source.getSnapshot().context.summary?.head).toBe("a")
  })

  test("asks a starting location again with a growing backoff, then decides jj-graph is absent", async () => {
    const clock = new SimulatedClock()
    const { client, reads } = controlledClient()
    const source = createActor(connect(client), { clock }).start()
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
      reads[attempt - 1].fail(booting)
      await settle()
      expect(source.getSnapshot().matches("waiting")).toBe(true)
      clock.increment(backoff(attempt) - 1)
      expect(reads).toHaveLength(attempt)
      clock.increment(1)
      expect(reads).toHaveLength(attempt + 1)
    }
    reads[RETRIES].fail(booting)
    await settle()
    expect(source.getSnapshot().matches("absent")).toBe(true)
    // A change proves jj-graph runs after all.
    source.send(changed({ ...summaryOf("b") }))
    expect(source.getSnapshot().matches("loading")).toBe(true)
  })

  // Regression: the desktop loader started a read for every change, so two
  // reads could overlap and the older answer could land last.
  test("a change during a read waits for it and reads once more, one read at a time", async () => {
    const tracked = controlledClient()
    const source = createActor(connect(tracked.client)).start()
    source.send(changed(summaryOf("b")))
    source.send(changed(summaryOf("c")))
    expect(tracked.reads).toHaveLength(1)
    expect(source.getSnapshot().matches({ loading: "stale" })).toBe(true)
    tracked.reads[0].answer(graph("a"))
    await settle()
    // The stale answer is shown while the next read runs.
    expect(source.getSnapshot().context.state?.head).toBe("a")
    expect(source.getSnapshot().matches({ loading: "current" })).toBe(true)
    expect(tracked.reads).toHaveLength(2)
    tracked.reads[1].answer(graph("c"))
    await settle()
    expect(source.getSnapshot().matches("ready")).toBe(true)
    expect(source.getSnapshot().context.state?.head).toBe("c")
    expect(tracked.mostInFlight()).toBe(1)
  })

  // Regression: the TUI applied a read that was in flight when jj-graph said
  // it could no longer read the repository, putting a graph back on screen.
  test("jj-graph going away drops the read in flight", async () => {
    const { client, reads } = controlledClient()
    const source = createActor(connect(client)).start()
    source.send(changed({ unavailable: "jj-graph exited (code 1)" }))
    expect(reads[0].signal.aborted).toBe(true)
    reads[0].answer(graph("late"))
    await settle()
    const snapshot = source.getSnapshot()
    expect(snapshot.matches("unavailable")).toBe(true)
    expect(snapshot.context.state).toBeNull()
    expect(published(snapshot)).toEqual({ unavailable: "jj-graph exited (code 1)" })
  })

  test("a read that jj-graph cannot answer, and an unexpected failure that keeps the last graph", async () => {
    const { client, reads } = controlledClient()
    const source = createActor(connect(client)).start()
    reads[0].fail({ type: "unavailable", message: "x", data: { reason: "not a jj repository" } })
    await settle()
    expect(source.getSnapshot().matches("unavailable")).toBe(true)
    expect(source.getSnapshot().context.reason).toBe("not a jj repository")

    source.send(changed(summaryOf("a")))
    reads[1].answer(graph("a"))
    await settle()
    source.send(changed(summaryOf("b")))
    reads[2].fail(new Error("socket closed"))
    await settle()
    expect(source.getSnapshot().matches("failed")).toBe(true)
    expect(source.getSnapshot().context.error).toBe("socket closed")
    expect(source.getSnapshot().context.state?.head).toBe("a")
  })

  test("refresh asks the server plugin to re-read, then reads", async () => {
    const tracked = controlledClient()
    const source = createActor(connect(tracked.client)).start()
    tracked.reads[0].answer(graph("a"))
    await settle()
    source.send({ type: "REFRESH" })
    expect(source.getSnapshot().matches("refreshing")).toBe(true)
    expect(source.getSnapshot().can({ type: "REFRESH" })).toBe(false)
    await settle()
    expect(tracked.refreshes()).toBe(1)
    expect(source.getSnapshot().matches("loading")).toBe(true)
    expect(tracked.reads).toHaveLength(2)
  })
})

function summaryOf(head: string) {
  return {
    repo: "/r",
    head,
    mutable: 0,
    conflicted: 0,
    divergent: 0,
    shape: "single",
    status: "clean",
    diagnostics: { errors: 0, warnings: 0, info: 0 },
    plan: { active: false, steps: [], redo: 0, stale: null },
    tone: "ok" as const,
  }
}

const rows = (graphKeys: string[], plan: string[] = []): Rows => ({ graph: graphKeys, plan, jjr: [], ops: [] })

function view(surface: Surface = "gui") {
  const actor = createActor(viewMachine, { input: { surface } }).start()
  const emitted: { type: string }[] = []
  for (const type of ["copy", "scroll", "refresh", "fullscreen", "close"] as const)
    actor.on(type, (event) => emitted.push(event))
  return { actor, emitted }
}

describe("graph view", () => {
  test("the mode line reads PROMPT until the panel has the keyboard, then NORMAL and DETAIL", () => {
    const { actor } = view()
    expect(badge(actor.getSnapshot())).toBe("PROMPT")
    actor.send({ type: "FOCUS" })
    expect(badge(actor.getSnapshot())).toBe("NORMAL")
    actor.send({ type: "ROWS", rows: rows(["a"]), wc: null })
    actor.send({ type: "OPEN" })
    expect(badge(actor.getSnapshot())).toBe("DETAIL")
    actor.send({ type: "BLUR" })
    expect(badge(actor.getSnapshot())).toBe("PROMPT")
    actor.send({ type: "FOCUS" })
    actor.send({ type: "BACK" })
    expect(badge(actor.getSnapshot())).toBe("NORMAL")
  })

  test("the hint line lists each surface's keys and dims what the machine would refuse", () => {
    const labels = (surface: Surface) => hints(view(surface).actor.getSnapshot()).map((h) => h.hint)
    expect(labels("gui")).toEqual(["j/k", "h/l", "⏎", "y", "r"])
    expect(labels("panel")).toEqual(["j/k", "h/l", "⏎", "y", "r", "f", "esc"])
    expect(labels("screen")).toEqual(["j/k", "h/l", "⏎", "y", "r", "esc"])

    const { actor } = view()
    const enabled = () => Object.fromEntries(hints(actor.getSnapshot()).map((h) => [h.hint, h.enabled]))
    expect(enabled()["⏎"]).toBe(false)
    expect(enabled()["y"]).toBe(false)
    actor.send({ type: "ROWS", rows: rows(["a"]), wc: null })
    expect(enabled()["⏎"]).toBe(true)
    actor.send({ type: "OPEN" })
    expect(hints(actor.getSnapshot()).map((h) => h.hint)).toEqual(["j/k", "y", "esc"])
  })

  test("no key does two things in one mode", () => {
    for (const surface of ["gui", "panel", "screen"] as const) {
      const { actor } = view(surface)
      actor.send({ type: "ROWS", rows: rows(["a"]), wc: null })
      for (const open of [false, true]) {
        if (open) actor.send({ type: "OPEN" })
        const keys = bindings(actor.getSnapshot()).flatMap((b) => [...b.gui, ...b.tui.split(",")]).filter(Boolean)
        const gui = bindings(actor.getSnapshot()).flatMap((b) => b.gui)
        expect(new Set(gui).size).toBe(gui.length)
        expect(keys.length).toBeGreaterThan(0)
      }
    }
  })

  test("the graph starts on the working copy", () => {
    const { actor } = view()
    actor.send({ type: "ROWS", rows: rows(["a", "b", "c"]), wc: "b" })
    expect(selectedKey(actor.getSnapshot().context)).toBe("b")
  })

  // Regression: the cursor was a position, so a change added above the
  // selection moved it to another change, and an open detail switched rows.
  test("the selection and an open detail stay on their change when rows move", () => {
    const { actor } = view()
    actor.send({ type: "ROWS", rows: rows(["a", "b", "c"]), wc: null })
    actor.send({ type: "MOVE", by: 2 })
    expect(selectedKey(actor.getSnapshot().context)).toBe("c")
    actor.send({ type: "ROWS", rows: rows(["new", "a", "b", "c"]), wc: null })
    expect(selectedKey(actor.getSnapshot().context)).toBe("c")
    actor.send({ type: "OPEN" })
    actor.send({ type: "ROWS", rows: rows(["newer", "new", "a", "b", "c"]), wc: null })
    expect(actor.getSnapshot().matches({ mode: "detail" })).toBe(true)
    expect(selectedKey(actor.getSnapshot().context)).toBe("c")
    // The row it was opened on goes away: back to the list, on what took its place.
    actor.send({ type: "ROWS", rows: rows(["newer", "new", "a", "b"]), wc: null })
    expect(actor.getSnapshot().matches({ mode: "normal" })).toBe(true)
    expect(selectedKey(actor.getSnapshot().context)).toBe("b")
  })

  test("sections cycle, keep their own selection, and always open on the list", () => {
    const { actor } = view()
    actor.send({ type: "ROWS", rows: rows(["a", "b"], ["s1", "s2"]), wc: null })
    actor.send({ type: "MOVE", by: 1 })
    actor.send({ type: "NEXT_SECTION" })
    expect(actor.getSnapshot().context.section).toBe("plan")
    expect(selectedKey(actor.getSnapshot().context)).toBe("s1")
    actor.send({ type: "OPEN" })
    actor.send({ type: "SHOW", section: "graph" })
    expect(actor.getSnapshot().matches({ mode: "normal" })).toBe(true)
    expect(selectedKey(actor.getSnapshot().context)).toBe("b")
    actor.send({ type: "PREV_SECTION" })
    expect(actor.getSnapshot().context.section).toBe("ops")
    actor.send({ type: "NEXT_SECTION" })
    expect(actor.getSnapshot().context.section).toBe("graph")
  })

  test("a click selects a row, and a second click opens it", () => {
    const { actor } = view()
    actor.send({ type: "ROWS", rows: rows(["a", "b"]), wc: null })
    actor.send({ type: "PICK", key: "b" })
    expect(selectedKey(actor.getSnapshot().context)).toBe("b")
    expect(actor.getSnapshot().matches({ mode: "normal" })).toBe(true)
    actor.send({ type: "PICK", key: "b" })
    expect(actor.getSnapshot().matches({ mode: "detail" })).toBe(true)
  })

  test("copy, refresh, scroll, full screen and close are emitted, each only where it applies", () => {
    const gui = view("gui")
    gui.actor.send({ type: "COPY" })
    expect(gui.emitted).toEqual([])
    gui.actor.send({ type: "ROWS", rows: rows(["a"]), wc: null })
    gui.actor.send({ type: "COPY" })
    gui.actor.send({ type: "REFRESH" })
    gui.actor.send({ type: "FULLSCREEN" })
    gui.actor.send({ type: "CLOSE" })
    gui.actor.send({ type: "OPEN" })
    gui.actor.send({ type: "SCROLL", by: 1 })
    expect(gui.emitted).toEqual([
      { type: "copy", section: "graph", key: "a" },
      { type: "refresh" },
      { type: "scroll", by: 1 },
    ])

    const panel = view("panel")
    panel.actor.send({ type: "FULLSCREEN" })
    panel.actor.send({ type: "CLOSE" })
    expect(panel.emitted).toEqual([{ type: "fullscreen" }, { type: "close" }])
    const screen = view("screen")
    screen.actor.send({ type: "FULLSCREEN" })
    screen.actor.send({ type: "CLOSE" })
    expect(screen.emitted).toEqual([{ type: "close" }])
  })
})
