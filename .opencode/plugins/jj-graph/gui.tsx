// OpenCode desktop part of the jj-graph plugin: a "jj graph" tab in the
// session's side region with the graph and its lanes, the agent's dry-run
// plan, jjr's diagnostics and the operation log, fed by the jj-graph RPC
// (rpc.ts) that the server part (index.ts) publishes. Built into
// gui-experimental.cjs by opencode-gui/ at the repository root.
//
// Two XState machines run the tab: source.machine.ts reads the session's
// directory, and view.machine.ts holds the panel's focus, mode, section and
// selection. The panel's bottom line always names the mode (NORMAL, DETAIL,
// or PROMPT while it does not have keyboard focus) and lists the keys that
// work in it, both read from the view machine's current state.
import { Command, MenuItem, Panel, Plugin, Style, type MountedSession, type PanelTab } from "@opencode/plugin/gui"
import { createEffect, createMemo, For, on, onCleanup, Show } from "solid-js"
import { createActor } from "xstate"
import { useSnapshot } from "./actor"
import css from "./gui.css?inline"
import * as M from "./model"
import { JjGraph } from "./rpc"
import { changed, connect } from "./source.machine"
import * as V from "./view.machine"

type Ctx = Parameters<Plugin.Setup>[0]

const EMPTY: Readonly<Record<V.SectionID, string>> = {
  graph: "No revisions in the revset.",
  plan: "No dry run is open.",
  jjr: "No diagnostics.",
  ops: "No operations.",
}

/** One source actor for the session's directory on its server, replaced when either changes. */
function useSource(session: () => MountedSession) {
  const source = createMemo(() => {
    const directory = session().directory
    const rpc = session().server.client.rpc(JjGraph)
    const actor = createActor(
      connect({
        state: async (signal) => (await rpc.state({}, { location: { directory }, signal })) as M.State,
        refresh: () => rpc.refresh({}, { location: { directory } }),
      }),
    ).start()
    const controller = new AbortController()
    rpc.events.on(
      "changed",
      (event) => {
        if (event.location.directory === directory) actor.send(changed(event.data.summary as M.Published))
      },
      { signal: controller.signal },
    )
    onCleanup(() => {
      controller.abort()
      actor.stop()
    })
    return actor
  })
  const snapshot = createMemo(() => useSnapshot(source()))
  return { source, snapshot: () => snapshot()() }
}

const keysOf = (rows: Record<V.SectionID, M.Row[]>): V.Rows => ({
  graph: rows.graph.map((row) => row.key),
  plan: rows.plan.map((row) => row.key),
  jjr: rows.jjr.map((row) => row.key),
  ops: rows.ops.map((row) => row.key),
})

function GraphPanel(props: { ctx: Ctx; session: MountedSession }) {
  const ctx = props.ctx
  const graph = useSource(() => props.session)
  const state = () => graph.snapshot().context.state ?? undefined
  const rows = createMemo<Record<V.SectionID, M.Row[]>>(() => {
    const value = state()
    if (!value) return { graph: [], plan: [], jjr: [], ops: [] }
    return { graph: M.graphRows(value), plan: M.planRows(value), jjr: M.diagnosticRows(value), ops: M.opRows(value) }
  })
  const summary = createMemo(() => {
    const value = state()
    return value ? M.summarize(value) : undefined
  })

  const view = createActor(V.viewMachine, { input: { surface: "gui" } }).start()
  onCleanup(() => view.stop())
  const snapshot = useSnapshot(view)
  createEffect(
    on(rows, (value) =>
      view.send({ type: "ROWS", rows: keysOf(value), wc: value.graph.find((row) => row.glyph === "@")?.key ?? null }),
    ),
  )

  const section = () => snapshot().context.section
  const list = createMemo(() => rows()[section()])
  const index = createMemo(() => V.cursorIndex(snapshot().context))
  const selected = createMemo<M.Row | undefined>(() => list()[index()])
  let root: HTMLDivElement | undefined
  let detail: HTMLDivElement | undefined
  createEffect(on(index, (row) => root?.querySelector(`[data-row="${row}"]`)?.scrollIntoView({ block: "nearest" })))

  view.on("copy", (event) => {
    const value = rows()[event.section].find((row) => row.key === event.key)?.copy
    if (!value) return
    void ctx.system.copy(value).then(() => ctx.toast.show({ title: "Copied", description: value.slice(0, 120) } as never))
  })
  view.on("scroll", (event) => detail?.scrollBy({ top: 40 * event.by }))
  view.on("refresh", () => graph.source().send({ type: "REFRESH" }))

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return
    const binding = V.bindings(snapshot()).find((candidate) => candidate.gui.includes(event.key))
    if (!binding || !snapshot().can(binding.event)) return
    event.preventDefault()
    event.stopPropagation()
    view.send(binding.event)
  }

  const badge = () => V.badge(snapshot())
  const hints = createMemo(() => {
    if (badge() === "PROMPT") {
      const toggle = ctx.keybinds.keybind(`${ctx.id}.open`)
      return [
        { keys: ["Click"], label: "focus this panel", enabled: true },
        ...(toggle.length ? [{ keys: toggle, label: "toggle panel", enabled: true }] : []),
      ]
    }
    return V.hints(snapshot()).map((hint) => ({
      keys: ctx.keybinds.keys(hint.hint === "⏎" ? "enter" : hint.hint === "esc" ? "escape" : hint.hint),
      label: hint.label,
      enabled: hint.enabled,
    }))
  })
  const tabTone = (id: V.SectionID): M.Tone | undefined => {
    const value = summary()
    if (!value) return undefined
    if (id === "plan") return value.plan.stale ? "warn" : value.plan.active ? "busy" : undefined
    if (id === "jjr") return value.diagnostics.errors ? "error" : value.diagnostics.warnings ? "warn" : undefined
    if (id === "graph") return value.conflicted ? "error" : value.divergent ? "warn" : undefined
    return undefined
  }
  const status = () => {
    const source = graph.snapshot()
    const value = source.context.state
    if (value) return M.heading(value)
    if (source.matches("unavailable")) return `jj-graph is unavailable: ${source.context.reason}`
    if (source.matches("failed")) return source.context.error ?? "jj-graph failed."
    if (source.matches("absent")) return "jj-graph is not running for this directory."
    return "Loading…"
  }
  const name = () => props.session.directory.split("/").filter(Boolean).at(-1) ?? props.session.directory

  return (
    <div
      ref={root}
      class="jjg"
      tabindex="0"
      style={{ "--jjg-mono": ctx.appearance.font("mono") }}
      onKeyDown={onKeyDown}
      onFocusIn={() => view.send({ type: "FOCUS" })}
      onFocusOut={(event) => {
        if (!root?.contains(event.relatedTarget as Node | null)) view.send({ type: "BLUR" })
      }}
    >
      <header class="jjg-head">
        <strong>jj graph</strong>
        <span class="jjg-muted">{name()}</span>
        <span class="jjg-status jjg-muted">{status()}</span>
      </header>
      <nav class="jjg-tabs">
        <For each={V.SECTIONS}>
          {(id, position) => (
            <button
              type="button"
              classList={{ "jjg-tab": true, "jjg-tab-on": section() === id }}
              onClick={() => {
                view.send({ type: "SHOW", section: id })
                root?.focus()
              }}
            >
              <span class="jjg-muted">{position() + 1}</span> {V.TITLES[id]}
              <Show when={tabTone(id)}>
                {(tone) => <span class={`jjg-tone-${tone()}`}> {M.glyph[tone()]}</span>}
              </Show>
            </button>
          )}
        </For>
      </nav>
      <Show
        when={snapshot().matches({ mode: "normal" })}
        fallback={
          <div ref={detail} class="jjg-detail">
            <strong>{selected()?.label}</strong>
            <pre>{selected()?.lines.join("\n")}</pre>
          </div>
        }
      >
        <div class="jjg-list" role="listbox">
          <Show when={list().length > 0} fallback={<p class="jjg-muted jjg-empty">{state() ? EMPTY[section()] : status()}</p>}>
            <For each={list()}>
              {(row, position) => (
                <div
                  role="option"
                  data-row={position()}
                  aria-selected={position() === index()}
                  classList={{ "jjg-row": true, "jjg-row-on": position() === index() }}
                  onClick={() => {
                    view.send({ type: "PICK", key: row.key })
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
