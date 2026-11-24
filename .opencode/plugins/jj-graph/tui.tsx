// OpenCode TUI part of the jj-graph plugin: the state of the repository's jj
// graph beside a session. A sidebar section and a home-footer item summarize
// the working copy, the stack, the agent's dry-run plan and jjr's verdict; the
// jj graph panel (`<leader>j`, `/jj-graph`) shows the graph with its lanes, the
// plan step by step, jjr's diagnostics and the operation log. The server part
// (index.ts) publishes all of it through the jj-graph RPC (rpc.ts).
//
// Wherever the panel takes keys, its bottom line names the mode (NORMAL,
// DETAIL, or PROMPT while the panel is unfocused) and lists every key that
// works in it.
import { Plugin } from "@opencode/plugin/tui"
import type { PanelInput, Route } from "@opencode/plugin/tui/context"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, Index, on, Show } from "solid-js"
import * as M from "./model"
import { JjGraph } from "./rpc"

type Context = Plugin.Context
type Theme = Context["theme"]
type SectionID = "graph" | "plan" | "jjr" | "ops"

const PANEL = "jj-graph"
const OPEN = "jj-graph.open"
const SECTIONS: readonly SectionID[] = ["graph", "plan", "jjr", "ops"]
const TITLES: Readonly<Record<SectionID, string>> = { graph: "Graph", plan: "Plan", jjr: "jjr", ops: "Ops" }
const EMPTY: Readonly<Record<SectionID, string>> = {
  graph: "no revisions in the revset",
  plan: "no dry run is open",
  jjr: "no diagnostics",
  ops: "no operations",
}
// Below this width the panel names only the current section.
const NARROW = 44
// How long to keep asking a cold location before deciding jj-graph is not there.
const RETRIES = 8

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

/** One directory's state as the views see it, fed by the RPC and its `changed` events. */
interface Hub {
  readonly state: () => M.State | undefined
  readonly summary: () => M.Published | undefined
  readonly error: () => string | undefined
  /** jj-graph does not run here: not a jj repository, or the plugin is off. */
  readonly absent: () => boolean
  readonly updated: () => number | undefined
  refresh(): void
}

interface Hubs {
  get(directory: string): Hub
  dispose(): void
}

function createHubs(context: Context): Hubs {
  const rpc = () => context.client.rpc(JjGraph)
  const hubs = new Map<string, Hub & { changed(data: M.Published): void; dispose(): void }>()
  const off = rpc().events.on("changed", (event) => {
    hubs.get(event.location.directory)?.changed(event.data.summary as M.Published)
  })

  const create = (directory: string) => {
    const [state, setState] = createSignal<M.State>()
    const [summary, setSummary] = createSignal<M.Published>()
    const [error, setError] = createSignal<string>()
    const [absent, setAbsent] = createSignal(false)
    const [updated, setUpdated] = createSignal<number>()
    const timers = new Set<ReturnType<typeof setTimeout>>()
    let loading = false
    let again = false
    const later = (ms: number, run: () => void) => {
      const timer = setTimeout(() => {
        timers.delete(timer)
        run()
      }, ms)
      timers.add(timer)
    }
    const load = async (attempt = 0): Promise<void> => {
      if (loading) {
        again = true
        return
      }
      loading = true
      try {
        const next = (await rpc().state({}, { location: { directory } })) as M.State
        setState(next)
        setSummary(M.summarize(next))
        setError(undefined)
        setAbsent(false)
        setUpdated(Date.now())
      } catch (caught) {
        const failure = caught as { type?: string; message?: string; data?: { reason?: string } }
        if (failure?.type === "rpc.unavailable" || failure?.type === "rpc.method_not_found") {
          // A location boots its server plugins on first use; ask again a few times.
          if (attempt < RETRIES) later(500 * (attempt + 1), () => void load(attempt + 1))
          else setAbsent(true)
        } else if (failure?.type === "unavailable") {
          setState(undefined)
          setSummary({ unavailable: failure.data?.reason ?? failure.message ?? "unavailable" })
        } else setError(failure?.message ?? String(caught))
      } finally {
        loading = false
        if (again) {
          again = false
          void load()
        }
      }
    }
    void load()
    return {
      state,
      summary,
      error,
      absent,
      updated,
      refresh: () => {
        void rpc()
          .refresh({}, { location: { directory } })
          .catch(() => undefined)
          .then(() => load())
      },
      changed: (data: M.Published) => {
        setAbsent(false)
        setSummary(data)
        if (M.isUnavailable(data)) setState(undefined)
        else void load()
      },
      dispose: () => {
        for (const timer of timers) clearTimeout(timer)
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
  const summary = () => props.hub()?.summary()
  const lines = createMemo(() => {
    const value = summary()
    return value === undefined || M.isUnavailable(value) ? [] : M.summaryLines(value)
  })
  const shortcut = () => props.context.keymap.shortcuts(OPEN)[0]
  const sectionOf = (key: M.SummaryLine["key"]): SectionID => (key === "plan" ? "plan" : key === "jjr" ? "jjr" : "graph")

  return (
    <Show when={props.hub() && !props.hub()!.absent()}>
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
  const summary = () => props.hub()?.summary()
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
    <Show when={!props.hub()?.absent() && text()}>
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

interface Key {
  readonly bind: string
  readonly title: string
  /** Shown in the hint line as `hint label`; a key without one shares another's, as k shares j/k. */
  readonly hint?: string
  readonly label?: string
  readonly enabled?: () => boolean
  readonly run: () => void
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
  const state = () => props.hub()?.state()
  const summary = () => props.hub()?.summary()

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

  // NORMAL moves through a section's rows; DETAIL reads one row. Esc goes back
  // one step: from DETAIL to NORMAL, and from NORMAL out of the view.
  const [mode, setMode] = createSignal<"normal" | "detail">("normal")
  const [section, setSection] = createSignal<SectionID>(props.request()?.section ?? "graph")
  createEffect(
    on(
      props.request,
      (request) => {
        if (!request) return
        setSection(request.section)
        setMode("normal")
      },
      { defer: true },
    ),
  )
  const [cursors, setCursors] = createSignal<Partial<Record<SectionID, number>>>({})
  const rows = createMemo(() => sectionRows()[section()])
  // Start the graph on the working copy.
  createEffect(
    on(
      () => sectionRows().graph,
      (graph) => {
        if (cursors().graph !== undefined || graph.length === 0) return
        const wc = graph.findIndex((row) => row.glyph === "@")
        if (wc > 0) setCursors((current) => ({ ...current, graph: wc }))
      },
    ),
  )
  const index = createMemo(() => Math.min(Math.max(cursors()[section()] ?? 0, 0), Math.max(rows().length - 1, 0)))
  const selected = createMemo<M.Row | undefined>(() => rows()[index()])

  const docked = () => props.panel?.presentation === "panel"
  const focused = () => props.panel === undefined || props.panel.presentation === "fullscreen" || props.panel.focused
  const width = () => props.panel?.width ?? dimensions().width
  const surface = () => (docked() ? theme().background.raised.base : theme().background.base)
  const highlight = () => (docked() ? theme().background.raised.high : theme().background.raised.base)
  let list: unknown
  let detail: unknown

  const select = (next: number) => {
    const target = Math.min(Math.max(next, 0), Math.max(rows().length - 1, 0))
    setCursors((current) => ({ ...current, [section()]: target }))
    keepVisible(list, target)
  }
  const show = (id: SectionID | undefined) => {
    if (id === undefined) return
    setSection(id)
    setMode("normal")
  }
  const cycle = (offset: number) =>
    show(SECTIONS[(SECTIONS.indexOf(section()) + offset + SECTIONS.length) % SECTIONS.length])
  const copySelected = async () => {
    const value = selected()?.copy
    if (!value) return
    const copied = await copyText(props.context.renderer, value)
    props.context.ui.toast.show({
      variant: copied ? "success" : "warning",
      title: copied ? "Copied" : "Nothing copied",
      message: copied ? value.slice(0, 120) : "No clipboard is available here",
      duration: 2_500,
    })
  }
  const scrollDetail = (delta: number) =>
    (detail as { scrollBy?: (rows: number) => void } | undefined)?.scrollBy?.(delta)

  const normal: readonly Key[] = [
    { bind: "j,down", title: "Next row", hint: "j/k", label: "move", run: () => select(index() + 1) },
    { bind: "k,up", title: "Previous row", run: () => select(index() - 1) },
    { bind: "g,home", title: "First row", run: () => select(0) },
    { bind: "shift+g,end", title: "Last row", run: () => select(rows().length - 1) },
    { bind: "l,right,tab", title: "Next section", hint: "h/l", label: "section", run: () => cycle(1) },
    { bind: "h,left", title: "Previous section", run: () => cycle(-1) },
    ...SECTIONS.map(
      (id, position): Key => ({ bind: String(position + 1), title: `Show ${TITLES[id]}`, run: () => show(id) }),
    ),
    {
      bind: "return",
      title: "Show details",
      hint: "⏎",
      label: "details",
      enabled: () => selected() !== undefined,
      run: () => setMode("detail"),
    },
    {
      bind: "y",
      title: "Copy the change id, step, fix or operation",
      hint: "y",
      label: "copy",
      enabled: () => selected() !== undefined,
      run: () => void copySelected(),
    },
    { bind: "r", title: "Read the repository again", hint: "r", label: "refresh", run: () => props.hub()?.refresh() },
    {
      bind: "f",
      title: "Toggle full screen",
      hint: "f",
      label: "full screen",
      enabled: () => props.panel !== undefined,
      run: () => props.panel?.toggleFullscreen(),
    },
    { bind: "escape,q", title: "Close the jj graph view", hint: "esc", label: "close", run: () => props.onClose() },
  ]
  const details: readonly Key[] = [
    { bind: "j,down", title: "Scroll down", hint: "j/k", label: "scroll", run: () => scrollDetail(1) },
    { bind: "k,up", title: "Scroll up", run: () => scrollDetail(-1) },
    {
      bind: "y",
      title: "Copy the change id, step, fix or operation",
      hint: "y",
      label: "copy",
      enabled: () => selected() !== undefined,
      run: () => void copySelected(),
    },
    { bind: "escape,return,q", title: "Back to the list", hint: "esc", label: "back", run: () => setMode("normal") },
  ]
  const keys = () => (mode() === "detail" ? details : normal)

  // Inside the session panel this layer is live only while the panel has
  // focus; the hint line then switches from how to focus it to these keys.
  props.context.keymap.layer(() => ({
    commands: keys().map((key) => ({
      bind: key.bind,
      title: key.title,
      group: "jj graph",
      enabled: key.enabled,
      run: () => {
        key.run()
      },
    })),
  }))

  const badge = () => (!focused() ? "PROMPT" : mode() === "detail" ? "DETAIL" : "NORMAL")
  const hints = createMemo(() => {
    if (!focused()) {
      const focus = props.context.keymap.shortcuts("pane.focus.right")[0]
      const close = props.context.keymap.shortcuts(OPEN)[0]
      return [
        ...(focus ? [{ key: focus, label: "focus this panel", enabled: true }] : []),
        ...(close ? [{ key: close, label: "close", enabled: true }] : []),
      ]
    }
    return keys().flatMap((key) =>
      key.hint === undefined
        ? []
        : [{ key: key.hint, label: key.label ?? key.title, enabled: key.enabled ? key.enabled() : true }],
    )
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
    const value = state()
    if (value) return M.heading(value)
    const published = summary()
    if (published && M.isUnavailable(published)) return `unavailable: ${published.unavailable}`
    return props.hub()?.error() ?? (props.hub()?.absent() ? "jj-graph is not running here" : "loading…")
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
            <b>{TITLES[section()]}</b>
            <span style={{ fg: theme().text.muted }}>
              {` ${SECTIONS.indexOf(section()) + 1}/${SECTIONS.length} · h/l section`}
            </span>
          </text>
        }
      >
        <box flexDirection="row" gap={2} flexShrink={0}>
          <For each={SECTIONS}>
            {(id, position) => (
              <text
                wrapMode="none"
                flexShrink={0}
                fg={id === section() ? theme().text.base : theme().text.muted}
                onMouseUp={() => show(id)}
              >
                <span style={{ fg: theme().text.muted }}>{position() + 1} </span>
                {id === section() ? <b>{TITLES[id]}</b> : TITLES[id]}
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
        when={mode() === "normal"}
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
                  onMouseUp={() => {
                    if (position === index()) setMode("detail")
                    else select(position)
                  }}
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
            !focused()
              ? theme().background.raised.high
              : mode() === "detail"
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
