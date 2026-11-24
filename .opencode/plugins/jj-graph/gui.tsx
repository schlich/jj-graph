// OpenCode desktop part of the jj-graph plugin: a "jj graph" tab in the
// session's side region with the graph and its lanes, the agent's dry-run
// plan, jjr's diagnostics and the operation log, fed by the jj-graph RPC
// (rpc.ts) that the server part (index.ts) publishes. Built into
// gui-experimental.cjs by opencode-gui/ at the repository root.
//
// The panel's bottom line always names its mode (NORMAL, DETAIL, or PROMPT
// while it does not have keyboard focus) and lists the keys that work in it.
import { Command, MenuItem, Panel, Plugin, Style, type MountedSession, type PanelTab } from "@opencode/plugin/gui"
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import css from "./gui.css?inline"
import * as M from "./model"
import { JjGraph } from "./rpc"

type SectionID = "graph" | "plan" | "jjr" | "ops"
type Ctx = Parameters<Plugin.Setup>[0]

const SECTIONS: readonly SectionID[] = ["graph", "plan", "jjr", "ops"]
const TITLES: Readonly<Record<SectionID, string>> = { graph: "Graph", plan: "Plan", jjr: "jjr", ops: "Ops" }
const EMPTY: Readonly<Record<SectionID, string>> = {
  graph: "No revisions in the revset.",
  plan: "No dry run is open.",
  jjr: "No diagnostics.",
  ops: "No operations.",
}
const RETRIES = 8

/** The state of one session's directory, re-read on every `changed` event for it. */
function useGraph(session: () => MountedSession) {
  const [state, setState] = createSignal<M.State>()
  const [problem, setProblem] = createSignal<string>()
  const [absent, setAbsent] = createSignal(false)
  const rpc = () => session().server.client.rpc(JjGraph)
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let current = ""

  const load = async (directory: string, attempt = 0): Promise<void> => {
    try {
      const next = (await rpc().state({}, { location: { directory } })) as M.State
      if (directory !== current) return
      setState(next)
      setProblem(undefined)
      setAbsent(false)
    } catch (caught) {
      if (directory !== current) return
      const failure = caught as { type?: string; message?: string; data?: { reason?: string } }
      if (failure?.type === "rpc.unavailable" || failure?.type === "rpc.method_not_found") {
        // A location boots its server plugins on first use; ask again a few times.
        if (attempt < RETRIES) {
          const timer = setTimeout(() => {
            timers.delete(timer)
            void load(directory, attempt + 1)
          }, 500 * (attempt + 1))
          timers.add(timer)
        } else setAbsent(true)
      } else if (failure?.type === "unavailable") {
        setState(undefined)
        setProblem(`jj-graph is unavailable: ${failure.data?.reason ?? failure.message}`)
      } else setProblem(failure?.message ?? String(caught))
    }
  }

  createEffect(
    on(
      () => session().directory,
      (directory) => {
        current = directory
        setState(undefined)
        setProblem(undefined)
        setAbsent(false)
        void load(directory)
      },
    ),
  )
  createEffect(
    on(
      () => session().server.client,
      (client) => {
        const controller = new AbortController()
        client.rpc(JjGraph).events.on(
          "changed",
          (event) => {
            if (event.location.directory === current) void load(current)
          },
          { signal: controller.signal },
        )
        onCleanup(() => controller.abort())
      },
    ),
  )
  onCleanup(() => timers.forEach(clearTimeout))

  return {
    state,
    problem,
    absent,
    refresh: () => {
      void rpc()
        .refresh({}, { location: { directory: current } })
        .catch(() => undefined)
        .then(() => load(current))
    },
  }
}

interface Key {
  /** The keys that run it, as KeyboardEvent.key values. */
  readonly keys: readonly string[]
  /** Shown in the hint line; a key without one shares another's, as k shares j. */
  readonly hint?: string
  readonly label?: string
  readonly enabled?: () => boolean
  readonly run: () => void
}

function GraphPanel(props: { ctx: Ctx; session: MountedSession }) {
  const ctx = props.ctx
  const graph = useGraph(() => props.session)
  const rows = createMemo<Record<SectionID, M.Row[]>>(() => {
    const state = graph.state()
    if (!state) return { graph: [], plan: [], jjr: [], ops: [] }
    return { graph: M.graphRows(state), plan: M.planRows(state), jjr: M.diagnosticRows(state), ops: M.opRows(state) }
  })
  const summary = createMemo(() => {
    const state = graph.state()
    return state ? M.summarize(state) : undefined
  })

  // NORMAL moves through a section's rows; DETAIL reads one row. Escape goes
  // back from DETAIL to NORMAL.
  const [mode, setMode] = createSignal<"normal" | "detail">("normal")
  const [focused, setFocused] = createSignal(false)
  const [section, setSection] = createSignal<SectionID>("graph")
  const [cursors, setCursors] = createSignal<Partial<Record<SectionID, number>>>({})
  const list = createMemo(() => rows()[section()])
  createEffect(
    on(
      () => rows().graph,
      (graphRows) => {
        if (cursors().graph !== undefined || graphRows.length === 0) return
        const wc = graphRows.findIndex((row) => row.glyph === "@")
        if (wc > 0) setCursors((current) => ({ ...current, graph: wc }))
      },
    ),
  )
  const index = createMemo(() => Math.min(Math.max(cursors()[section()] ?? 0, 0), Math.max(list().length - 1, 0)))
  const selected = createMemo<M.Row | undefined>(() => list()[index()])
  let root: HTMLDivElement | undefined
  let detail: HTMLDivElement | undefined

  const select = (next: number) => {
    const target = Math.min(Math.max(next, 0), Math.max(list().length - 1, 0))
    setCursors((current) => ({ ...current, [section()]: target }))
    root?.querySelector(`[data-row="${target}"]`)?.scrollIntoView({ block: "nearest" })
  }
  const show = (id: SectionID) => {
    setSection(id)
    setMode("normal")
  }
  const cycle = (offset: number) =>
    show(SECTIONS[(SECTIONS.indexOf(section()) + offset + SECTIONS.length) % SECTIONS.length])
  const copy = async () => {
    const value = selected()?.copy
    if (!value) return
    await ctx.system.copy(value)
    ctx.toast.show({ title: "Copied", description: value.slice(0, 120) } as never)
  }

  const normal: readonly Key[] = [
    { keys: ["j", "ArrowDown"], hint: "j/k", label: "move", run: () => select(index() + 1) },
    { keys: ["k", "ArrowUp"], run: () => select(index() - 1) },
    { keys: ["g", "Home"], run: () => select(0) },
    { keys: ["G", "End"], run: () => select(list().length - 1) },
    { keys: ["l", "ArrowRight", "Tab"], hint: "h/l", label: "section", run: () => cycle(1) },
    { keys: ["h", "ArrowLeft"], run: () => cycle(-1) },
    ...SECTIONS.map((id, position): Key => ({ keys: [String(position + 1)], run: () => show(id) })),
    {
      keys: ["Enter"],
      hint: "⏎",
      label: "details",
      enabled: () => selected() !== undefined,
      run: () => setMode("detail"),
    },
    { keys: ["y"], hint: "y", label: "copy", enabled: () => selected() !== undefined, run: () => void copy() },
    { keys: ["r"], hint: "r", label: "refresh", run: () => graph.refresh() },
  ]
  const details: readonly Key[] = [
    { keys: ["j", "ArrowDown"], hint: "j/k", label: "scroll", run: () => detail?.scrollBy({ top: 40 }) },
    { keys: ["k", "ArrowUp"], run: () => detail?.scrollBy({ top: -40 }) },
    { keys: ["y"], hint: "y", label: "copy", enabled: () => selected() !== undefined, run: () => void copy() },
    { keys: ["Escape", "Enter", "q"], hint: "esc", label: "back", run: () => setMode("normal") },
  ]
  const keys = () => (mode() === "detail" ? details : normal)
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return
    const key = keys().find((candidate) => candidate.keys.includes(event.key))
    if (!key || (key.enabled && !key.enabled())) return
    event.preventDefault()
    event.stopPropagation()
    key.run()
  }

  const badge = () => (!focused() ? "PROMPT" : mode() === "detail" ? "DETAIL" : "NORMAL")
  const hints = createMemo(() => {
    if (!focused()) {
      const toggle = ctx.keybinds.keybind(`${ctx.id}.open`)
      return [
        { keys: ["Click"], label: "focus this panel", enabled: true },
        ...(toggle.length ? [{ keys: toggle, label: "toggle panel", enabled: true }] : []),
      ]
    }
    return keys().flatMap((key) =>
      key.hint === undefined
        ? []
        : [
            {
              keys: ctx.keybinds.keys(key.hint === "⏎" ? "enter" : key.hint === "esc" ? "escape" : key.hint),
              label: key.label ?? "",
              enabled: key.enabled ? key.enabled() : true,
            },
          ],
    )
  })
  const tabTone = (id: SectionID): M.Tone | undefined => {
    const value = summary()
    if (!value) return undefined
    if (id === "plan") return value.plan.stale ? "warn" : value.plan.active ? "busy" : undefined
    if (id === "jjr") return value.diagnostics.errors ? "error" : value.diagnostics.warnings ? "warn" : undefined
    if (id === "graph") return value.conflicted ? "error" : value.divergent ? "warn" : undefined
    return undefined
  }
  const status = () => {
    const state = graph.state()
    if (state) return M.heading(state)
    return graph.problem() ?? (graph.absent() ? "jj-graph is not running for this directory." : "Loading…")
  }
  const name = () => props.session.directory.split("/").filter(Boolean).at(-1) ?? props.session.directory

  return (
    <div
      ref={root}
      class="jjg"
      tabindex="0"
      style={{ "--jjg-mono": ctx.appearance.font("mono") }}
      onKeyDown={onKeyDown}
      onFocusIn={() => setFocused(true)}
      onFocusOut={(event) => {
        if (!root?.contains(event.relatedTarget as Node | null)) setFocused(false)
      }}
    >
      <header class="jjg-head">
        <strong>jj graph</strong>
        <span class="jjg-muted">{name()}</span>
        <span class="jjg-status jjg-muted">{status()}</span>
      </header>
      <nav class="jjg-tabs">
        <For each={SECTIONS}>
          {(id, position) => (
            <button
              type="button"
              classList={{ "jjg-tab": true, "jjg-tab-on": section() === id }}
              onClick={() => {
                show(id)
                root?.focus()
              }}
            >
              <span class="jjg-muted">{position() + 1}</span> {TITLES[id]}
              <Show when={tabTone(id)}>
                {(tone) => <span class={`jjg-tone-${tone()}`}> {M.glyph[tone()]}</span>}
              </Show>
            </button>
          )}
        </For>
      </nav>
      <Show
        when={mode() === "normal"}
        fallback={
          <div ref={detail} class="jjg-detail">
            <strong>{selected()?.label}</strong>
            <pre>{selected()?.lines.join("\n")}</pre>
          </div>
        }
      >
        <div class="jjg-list" role="listbox">
          <Show when={list().length > 0} fallback={<p class="jjg-muted jjg-empty">{graph.state() ? EMPTY[section()] : status()}</p>}>
            <For each={list()}>
              {(row, position) => (
                <div
                  role="option"
                  data-row={position()}
                  aria-selected={position() === index()}
                  classList={{ "jjg-row": true, "jjg-row-on": position() === index() }}
                  onClick={() => {
                    if (position() === index()) setMode("detail")
                    else select(position())
                    root?.focus()
                  }}
                >
                  <span class="jjg-lanes">{row.lanes?.before ?? ""}</span>
                  <span class={`jjg-glyph jjg-tone-${row.tone}`}>{row.glyph ?? M.glyph[row.tone]}</span>
                  <span class="jjg-lanes">{row.lanes?.after ?? ""}</span> <span class="jjg-label">{row.label}</span>
                  <Show when={row.detail}>
                    <span class="jjg-muted"> {row.detail}</span>
                  </Show>
                </div>
              )}
            </For>
          </Show>
        </div>
      </Show>
      <footer class="jjg-hints">
        <span classList={{ "jjg-mode": true, [`jjg-mode-${badge().toLowerCase()}`]: true }}>{badge()}</span>
        <For each={hints()}>
          {(hint) => (
            <span classList={{ "jjg-hint": true, "jjg-hint-off": !hint.enabled }}>
              <ctx.ui.Keybind keys={hint.keys} />
              <span class="jjg-muted">{hint.label}</span>
            </span>
          )}
        </For>
      </footer>
    </div>
  )
}

export default Plugin.define({
  setup(ctx) {
    ctx.add(Style, css)

    const tab: PanelTab = { id: "main", title: "jj graph", closable: "compact" } as PanelTab
    ctx.add(Panel, {
      id: "main",
      region: "side",
      list: (input) => (input.open.includes("main") ? [tab] : []),
      render: (props) => <GraphPanel ctx={ctx} session={props.session} />,
      enter: () => {
        ;(document.querySelector(".jjg") as HTMLElement | null)?.focus()
      },
    })

    const toggle = () => {
      const session = ctx.sessions.current()
      if (session) ctx.layout.toggle(`${ctx.id}:main`, session)
    }
    ctx.add(Command, {
      id: "open",
      title: "jj graph",
      description: "The jj graph, the agent's dry-run plan, jjr's diagnostics and the operation log",
      group: "jj graph",
      section: "session",
      bind: "mod+shift+j",
      slash: { name: "jj-graph" },
      run: toggle,
    })
    ctx.add(MenuItem, () => {
      const session = ctx.sessions.current()
      const opened = !!session && ctx.layout.state(`${ctx.id}:main`, session) !== "closed"
      return {
        menu: "session.panel" as const,
        id: "open",
        title: "jj graph",
        icon: "branch" as const,
        keybind: `${ctx.id}.open`,
        ...(opened ? { opened: true } : {}),
        run: () => {
          if (session) ctx.layout.open(`${ctx.id}:main`, session)
        },
      }
    })
  },
})
