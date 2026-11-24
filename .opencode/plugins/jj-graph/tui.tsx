// OpenCode TUI part of the jj-graph plugin: the state of the repository's jj
// graph beside a session. A sidebar section and a home-footer item summarize
// the working copy, the stack, the agent's dry-run plan and jjr's verdict; the
// jj graph panel (`<leader>j`, `/jj-graph`) shows the graph with its lanes, the
// plan step by step, jjr's diagnostics and the operation log. The server part
// (index.ts) publishes all of it through the jj-graph RPC (rpc.ts).
//
// Two XState machines run it, the same ones the desktop app runs:
// source.machine.ts reads each directory and follows its changes, and
// view.machine.ts holds the panel's focus, mode, section and selection.
// Wherever the panel takes keys, its bottom line names the mode (NORMAL,
// DETAIL, or PROMPT while the panel is unfocused) and lists every key that
// works in it, both read from the view machine's current state.
import { Plugin } from "@opencode/plugin/tui"
import type { PanelInput, Route } from "@opencode/plugin/tui/context"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, Index, on, onCleanup, Show, type Accessor } from "solid-js"
import { createActor, type ActorRefFrom, type SnapshotFrom } from "xstate"
import { snapshotOf, useSnapshot } from "./actor"
import * as M from "./model"
import { JjGraph } from "./rpc"
import { changed, connect, published, type sourceMachine } from "./source.machine"
import * as V from "./view.machine"

type Context = Plugin.Context
type Theme = Context["theme"]
type SectionID = V.SectionID

const PANEL = "jj-graph"
const OPEN = "jj-graph.open"
const EMPTY: Readonly<Record<SectionID, string>> = {
  graph: "no revisions in the revset",
  plan: "no dry run is open",
  jjr: "no diagnostics",
  ops: "no operations",
}
// Below this width the panel names only the current section.
const NARROW = 44

function toneColor(theme: Theme, tone: M.Tone) {
  switch (tone) {
    case "ok":
      return theme.text.feedback.success.base
    case "warn":
      return theme.text.feedback.warning.base
    case "error":
      return theme.text.feedback.error.base
    case "busy":
      return theme.text.feedback.info.base
    default:
      return theme.text.muted
  }
}

/** One directory's source actor and its snapshot, shared by the sidebar, the footer and the panel. */
interface Hub {
  readonly actor: ActorRefFrom<typeof sourceMachine>
  readonly snapshot: Accessor<SnapshotFrom<typeof sourceMachine>>
}

interface Hubs {
  get(directory: string): Hub
  dispose(): void
}

/** What a sidebar shows for a hub: the summary, or why jj-graph cannot read the repository. */
const summaryOf = (hub: Hub | undefined) => (hub ? published(hub.snapshot()) : undefined)
/** jj-graph does not run in the hub's directory: not a jj repository, or the plugin is off. */
const absentIn = (hub: Hub | undefined) => hub?.snapshot().matches("absent") ?? false

function createHubs(context: Context): Hubs {
  const rpc = () => context.client.rpc(JjGraph)
  const hubs = new Map<string, Hub & { dispose(): void }>()
  const off = rpc().events.on("changed", (event) => {
    hubs.get(event.location.directory)?.actor.send(changed(event.data.summary as M.Published))
  })

  const create = (directory: string) => {
    const actor = createActor(
      connect({
        state: async (signal) => (await rpc().state({}, { location: { directory }, signal })) as M.State,
        refresh: () => rpc().refresh({}, { location: { directory } }),
      }),
    ).start()
    const { snapshot, dispose } = snapshotOf(actor)
    return {
      actor,
      snapshot,
      dispose: () => {
        dispose()
        actor.stop()
      },
    }
  }

  return {
    get: (directory) => {
      let hub = hubs.get(directory)
      if (!hub) {
        hub = create(directory)
        hubs.set(directory, hub)
      }
      return hub
    },
    dispose: () => {
      off()
      for (const hub of hubs.values()) hub.dispose()
      hubs.clear()
    },
  }
}

async function copyText(renderer: unknown, value: string): Promise<boolean> {
  try {
    const core = (await import("@opentui/core")) as Record<string, any>
    const clipboard = core.createClipboard({
      host: core.createHostClipboard(),
      terminal: core.createRendererClipboardAdapter(renderer),
    })
    try {
      const result = await clipboard.writeText(value.replaceAll("\0", ""), {
        destination: "all-available",
        selection: "clipboard",
      })
      return result?.host?.status === "written" || result?.terminal?.status === "attempted"
    } finally {
      await clipboard.dispose?.()
    }
  } catch {
    return false
  }
}

const basename = (directory: string) => directory.split("/").filter(Boolean).at(-1) ?? directory

function SidebarSection(props: { context: Context; hub: () => Hub | undefined; open: (section?: SectionID) => void }) {
  const theme = () => props.context.theme
  const summary = () => summaryOf(props.hub())
  const lines = createMemo(() => {
    const value = summary()
    return value === undefined || M.isUnavailable(value) ? [] : M.summaryLines(value)
  })
  const shortcut = () => props.context.keymap.shortcuts(OPEN)[0]
  const sectionOf = (key: M.SummaryLine["key"]): SectionID => (key === "plan" ? "plan" : key === "jjr" ? "jjr" : "graph")

  return (
    <Show when={props.hub() && !absentIn(props.hub())}>
      <box>
        <box flexDirection="row" justifyContent="space-between" gap={1} onMouseUp={() => props.open()}>
          <text fg={theme().text.base}>
            <b>jj graph</b>
          </text>
          <Show when={shortcut()}>
            {(key: () => string) => (
              <text fg={theme().text.muted} wrapMode="none" flexShrink={0}>
                {key()}
              </text>
            )}
          </Show>
        </box>
        <Show
          when={summary() !== undefined}
          fallback={
            <text fg={theme().text.muted} wrapMode="none">
              loading…
            </text>
          }
        >
          <Show
            when={!M.isUnavailable(summary())}
            fallback={
              <text fg={toneColor(theme(), "error")} wrapMode="word">
                {M.glyph.error} jj-graph unavailable: {(summary() as { unavailable: string }).unavailable}
              </text>
            }
          >
            <For each={lines()}>
              {(line) => (
                <box flexDirection="row" gap={1} minWidth={0} onMouseUp={() => props.open(sectionOf(line.key))}>
                  <text flexShrink={0} fg={toneColor(theme(), line.tone)}>
                    {M.glyph[line.tone]}
                  </text>
                  <text flexShrink={0} fg={theme().text.muted} wrapMode="none">
                    {line.label}
                  </text>
                  <text fg={theme().text.base} wrapMode="none" truncate flexGrow={1} flexShrink={1} minWidth={0}>
                    {line.text}
                  </text>
                </box>
              )}
            </For>
          </Show>
        </Show>
      </box>
    </Show>
  )
}

function HomeStatus(props: { context: Context; hub: () => Hub | undefined; open: () => void }) {
  const theme = () => props.context.theme
  const dimensions = useTerminalDimensions()
  const summary = () => summaryOf(props.hub())
  const text = createMemo(() => {
    const value = summary()
    if (value === undefined) return undefined
    if (M.isUnavailable(value)) return { tone: "error" as M.Tone, text: "jj-graph unavailable" }
    const parts = [value.workingCopy ? `@ ${M.short(value.workingCopy.change)}` : "jj"]
    parts.push(`${value.mutable} mutable`)
    if (value.plan.stale) parts.push("plan stale")
    else if (value.plan.active) parts.push(`plan ${value.plan.steps.length}`)
    if (value.diagnostics.errors) parts.push(`${value.diagnostics.errors} error`)
    return { tone: value.tone, text: parts.join(" · ") }
  })
  const shortcut = () => props.context.keymap.shortcuts(OPEN)[0]
  return (
    <Show when={!absentIn(props.hub()) && text()}>
      {(value: () => { tone: M.Tone; text: string }) => (
        <box flexDirection="row" gap={1} flexShrink={0} onMouseUp={() => props.open()}>
          <text fg={theme().text.base} wrapMode="none">
            <span style={{ fg: toneColor(theme(), value().tone) }}>◆ </span>
            {value().text}
          </text>
          <Show when={dimensions().width >= 100}>
            <text fg={theme().text.muted} wrapMode="none">
              {shortcut() ?? "/jj-graph"}
            </text>
          </Show>
        </box>
      )}
    </Show>
  )
}

function keepVisible(scroll: unknown, index: number) {
  const box = scroll as
    | { scrollTop?: number; height?: number; viewport?: { height?: number }; scrollTo?: (y: number) => void }
    | undefined
  if (typeof box?.scrollTo !== "function") return
  const top = typeof box.scrollTop === "number" ? box.scrollTop : 0
  const height = box.viewport?.height ?? box.height ?? 0
  if (index < top) box.scrollTo(index)
  else if (height > 0 && index >= top + height) box.scrollTo(index - height + 1)
}

/** A request, from a sidebar row, to show one section; `at` makes a repeat a change. */
interface Request {
  readonly section: SectionID
  readonly at: number
}

function GraphView(props: {
  context: Context
  hub: () => Hub | undefined
  directory: () => string | undefined
  panel?: PanelInput
  request: () => Request | undefined
  onClose: () => void
}) {
  const theme = () => props.context.theme
  const dimensions = useTerminalDimensions()
  const source = () => props.hub()?.snapshot()
  const state = () => source()?.context.state ?? undefined
  const summary = () => summaryOf(props.hub())

  const sectionRows = createMemo<Record<SectionID, M.Row[]>>(() => {
    const value = state()
    if (!value) return { graph: [], plan: [], jjr: [], ops: [] }
    return {
      graph: M.graphRows(value),
      plan: M.planRows(value),
      jjr: M.diagnosticRows(value),
      ops: M.opRows(value),
    }
  })

  const docked = () => props.panel?.presentation === "panel"
  const focused = () => props.panel === undefined || props.panel.presentation === "fullscreen" || props.panel.focused
  const width = () => props.panel?.width ?? dimensions().width
  const surface = () => (docked() ? theme().background.raised.base : theme().background.base)
  const highlight = () => (docked() ? theme().background.raised.high : theme().background.raised.base)
  let list: unknown
  let detail: unknown

  // NORMAL moves through a section's rows; DETAIL reads one row. Esc goes back
  // one step: from DETAIL to NORMAL, and from NORMAL out of the view.
  const view = createActor(V.viewMachine, {
    input: { surface: props.panel ? "panel" : "screen", section: props.request()?.section },
  }).start()
  onCleanup(() => view.stop())
  const snapshot = useSnapshot(view)
  createEffect(on(focused, (has) => view.send({ type: has ? "FOCUS" : "BLUR" })))
  createEffect(
    on(
      props.request,
      (request) => {
        if (request) view.send({ type: "SHOW", section: request.section })
      },
      { defer: true },
    ),
  )
  createEffect(
    on(sectionRows, (value) =>
      view.send({
        type: "ROWS",
        rows: { graph: value.graph.map((r) => r.key), plan: value.plan.map((r) => r.key), jjr: value.jjr.map((r) => r.key), ops: value.ops.map((r) => r.key) },
        wc: value.graph.find((row) => row.glyph === "@")?.key ?? null,
      }),
    ),
  )
  const section = () => snapshot().context.section
  const rows = createMemo(() => sectionRows()[section()])
  const index = createMemo(() => V.cursorIndex(snapshot().context))
  const selected = createMemo<M.Row | undefined>(() => rows()[index()])
  createEffect(on(index, (row) => keepVisible(list, row)))

  view.on("copy", (event) => {
    const value = sectionRows()[event.section].find((row) => row.key === event.key)?.copy
    if (!value) return
    void copyText(props.context.renderer, value).then((copied) =>
      props.context.ui.toast.show({
        variant: copied ? "success" : "warning",
        title: copied ? "Copied" : "Nothing copied",
        message: copied ? value.slice(0, 120) : "No clipboard is available here",
        duration: 2_500,
      }),
    )
  })
  view.on("scroll", (event) => (detail as { scrollBy?: (rows: number) => void } | undefined)?.scrollBy?.(event.by))
  view.on("refresh", () => props.hub()?.actor.send({ type: "REFRESH" }))
  view.on("fullscreen", () => props.panel?.toggleFullscreen())
  view.on("close", () => props.onClose())

  // Inside the session panel this layer is live only while the panel has
  // focus; the hint line then switches from how to focus it to these keys.
  // The keys are the current mode state's, and each is enabled exactly when
  // the view machine would take its event.
  props.context.keymap.layer(() => ({
    commands: V.bindings(snapshot()).map((binding) => ({
      bind: binding.tui,
      title: binding.title,
      group: "jj graph",
      enabled: () => snapshot().can(binding.event),
      run: () => {
        view.send(binding.event)
      },
    })),
  }))

  const badge = () => V.badge(snapshot())
  const hints = createMemo(() => {
    if (badge() === "PROMPT") {
      const focus = props.context.keymap.shortcuts("pane.focus.right")[0]
      const close = props.context.keymap.shortcuts(OPEN)[0]
      return [
        ...(focus ? [{ key: focus, label: "focus this panel", enabled: true }] : []),
        ...(close ? [{ key: close, label: "close", enabled: true }] : []),
      ]
    }
    return V.hints(snapshot()).map((hint) => ({ key: hint.hint, label: hint.label, enabled: hint.enabled }))
  })
  const tabBadge = (id: SectionID): M.Tone | undefined => {
    const value = summary()
    if (!value || M.isUnavailable(value)) return undefined
    if (id === "plan") return value.plan.stale ? "warn" : value.plan.active ? "busy" : undefined
    if (id === "jjr") return value.diagnostics.errors ? "error" : value.diagnostics.warnings ? "warn" : undefined
    if (id === "graph") return value.conflicted ? "error" : value.divergent ? "warn" : undefined
    return undefined
  }
  const status = createMemo(() => {
    const current = source()
    const value = state()
    if (value) return M.heading(value)
    if (current?.matches("unavailable")) return `unavailable: ${current.context.reason}`
    if (current?.matches("failed")) return current.context.error ?? "failed"
    return current?.matches("absent") ? "jj-graph is not running here" : "loading…"
  })

  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      backgroundColor={surface()}
      paddingLeft={2}
      paddingRight={1}
      paddingTop={docked() ? 1 : 0}
      onMouseDown={() => {
        if (props.panel && !props.panel.focused) props.panel.focus()
      }}
    >
      <box flexDirection="row" justifyContent="space-between" gap={1} flexShrink={0}>
        <text fg={theme().text.base} wrapMode="none" truncate flexShrink={1} minWidth={0}>
          <b>jj graph</b>
          <span style={{ fg: theme().text.muted }}> {basename(props.directory() ?? "") || "no directory"}</span>
        </text>
        <text fg={theme().text.muted} wrapMode="none" truncate flexShrink={1} minWidth={0}>
          {status()}
        </text>
      </box>
      <Show
        when={width() >= NARROW}
        fallback={
          <text fg={theme().text.base} wrapMode="none" flexShrink={0}>
            <b>{V.TITLES[section()]}</b>
            <span style={{ fg: theme().text.muted }}>
              {` ${V.SECTIONS.indexOf(section()) + 1}/${V.SECTIONS.length} · h/l section`}
            </span>
          </text>
        }
      >
        <box flexDirection="row" gap={2} flexShrink={0}>
          <For each={V.SECTIONS}>
            {(id, position) => (
              <text
                wrapMode="none"
                flexShrink={0}
                fg={id === section() ? theme().text.base : theme().text.muted}
                onMouseUp={() => view.send({ type: "SHOW", section: id })}
              >
                <span style={{ fg: theme().text.muted }}>{position() + 1} </span>
                {id === section() ? <b>{V.TITLES[id]}</b> : V.TITLES[id]}
                <Show when={tabBadge(id)}>
                  {(tone: () => M.Tone) => (
                    <span style={{ fg: toneColor(theme(), tone()) }}> {M.glyph[tone()]}</span>
                  )}
                </Show>
              </text>
            )}
          </For>
        </box>
      </Show>
      <box height={1} flexShrink={0} />
      <Show
        when={snapshot().matches({ mode: "normal" })}
        fallback={
          <scrollbox ref={(element: unknown) => (detail = element)} flexGrow={1} minHeight={0}>
            <text fg={theme().text.base} wrapMode="word">
              <b>{selected()?.label ?? ""}</b>
            </text>
            <For each={selected()?.lines ?? []}>
              {(line) => (
                <text fg={theme().text.base} wrapMode="word">
                  {line || " "}
                </text>
              )}
            </For>
          </scrollbox>
        }
      >
        <scrollbox ref={(element: unknown) => (list = element)} flexGrow={1} minHeight={0}>
          <Show
            when={rows().length > 0}
            fallback={
              <text fg={theme().text.muted} wrapMode="none">
                {state() ? EMPTY[section()] : status()}
              </text>
            }
          >
            <Index each={rows()}>
              {(row, position) => (
                <box
                  flexDirection="row"
                  minWidth={0}
                  backgroundColor={position === index() && focused() ? highlight() : surface()}
                  onMouseUp={() => view.send({ type: "PICK", key: row().key })}
                >
                  <text fg={theme().text.base} wrapMode="none" truncate flexGrow={1} flexShrink={1} minWidth={0}>
                    <span style={{ fg: theme().text.muted }}>{row().lanes?.before ?? ""}</span>
                    <span style={{ fg: toneColor(theme(), row().tone) }}>{row().glyph ?? M.glyph[row().tone]}</span>
                    <span style={{ fg: theme().text.muted }}>{row().lanes?.after ?? ""}</span> {row().label}
                    <Show when={row().detail}>
                      {(value: () => string) => <span style={{ fg: theme().text.muted }}>{`  ${value()}`}</span>}
                    </Show>
                  </text>
                </box>
              )}
            </Index>
          </Show>
        </scrollbox>
      </Show>
      <box flexDirection="row" gap={1} flexShrink={0} paddingTop={1} paddingBottom={docked() ? 1 : 0}>
        <box
          flexShrink={0}
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={
            badge() === "PROMPT"
              ? theme().background.raised.high
              : badge() === "DETAIL"
                ? theme().text.feedback.info.base
                : theme().text.base
          }
        >
          <text fg={focused() ? theme().background.base : theme().text.muted} wrapMode="none">
            <b>{badge()}</b>
          </text>
        </box>
        <text flexGrow={1} flexShrink={1} minWidth={0} wrapMode="word">
          <For each={hints()}>
            {(hint) => (
              <>
                <span style={{ fg: hint.enabled ? theme().text.base : theme().text.muted }}>{hint.key}</span>
                <span style={{ fg: theme().text.muted }}>{` ${hint.label}   `}</span>
              </>
            )}
          </For>
        </text>
      </box>
    </box>
  )
}

function Commands(props: { context: Context; toggle: () => void }) {
  props.context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: OPEN,
        title: "jj graph",
        description: "The repository's jj graph, the agent's dry-run plan, jjr's diagnostics and the operation log",
        group: "jj graph",
        // After the leader, j opens the jj graph, as o opens the workflow view.
        bind: "<leader>j",
        palette: true,
        slash: { name: "jj-graph" },
        run: () => props.toggle(),
      },
    ],
  }))
  return null
}

export default Plugin.define({
  id: "jj-graph",
  setup(context) {
    const hubs = createHubs(context)
    const hubFor = (directory: string | undefined) => (directory ? hubs.get(directory) : undefined)
    const [request, setRequest] = createSignal<Request>()
    let previous: Route = { type: "home" }

    // The command toggles the view; a sidebar row opens it at its section.
    const toggle = (section?: SectionID) => {
      if (section) setRequest({ section, at: Date.now() })
      const route = context.ui.router.current()
      context.ui.dialog.clear()
      const current = context.ui.panel.current()
      if (route.type === "session" && current?.name === PANEL && current.sessionID === route.sessionID) {
        if (!section) context.ui.panel.close()
        return
      }
      if (context.ui.panel.open(PANEL)) return
      // Outside a session there is no panel, so the view takes the screen.
      if (route.type === "plugin" && route.name === PANEL) {
        if (!section) context.ui.router.navigate(previous)
        return
      }
      // The router hands out a live store; keep a copy of where to return.
      previous =
        route.type === "session"
          ? { type: "session", sessionID: route.sessionID }
          : route.type === "plugin"
            ? { type: "plugin", id: route.id, name: route.name, ...(route.data ? { data: { ...route.data } } : {}) }
            : { type: "home" }
      context.ui.router.navigate({ type: "plugin", name: PANEL })
    }

    const sessionDirectory = (sessionID: string) =>
      context.data.session.get(sessionID)?.location?.directory ?? context.location?.directory

    context.ui.slot({
      append: "sidebar.content",
      render: (input) => (
        <SidebarSection context={context} hub={() => hubFor(sessionDirectory(input.sessionID))} open={toggle} />
      ),
    })
    context.ui.slot({
      append: "home.footer.status",
      render: () => (
        <HomeStatus context={context} hub={() => hubFor(context.location?.directory)} open={() => toggle()} />
      ),
    })
    context.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={panel.name === PANEL}>
          <GraphView
            context={context}
            hub={() => hubFor(sessionDirectory(panel.sessionID))}
            directory={() => sessionDirectory(panel.sessionID)}
            panel={panel}
            request={request}
            onClose={() => panel.close()}
          />
        </Show>
      ),
    })
    context.ui.router.register({
      name: PANEL,
      render: () => (
        <box
          width="100%"
          height="100%"
          backgroundColor={context.theme.background.base}
          paddingTop={1}
          paddingBottom={1}
        >
          <GraphView
            context={context}
            hub={() => hubFor(context.location?.directory)}
            directory={() => context.location?.directory}
            request={request}
            onClose={() => context.ui.router.navigate(previous)}
          />
        </box>
      ),
    })
    context.ui.slot({ append: "app", render: () => <Commands context={context} toggle={() => toggle()} /> })

    return () => hubs.dispose()
  },
})
