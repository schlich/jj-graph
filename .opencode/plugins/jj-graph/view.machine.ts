// xstate-version: 6
//
// The jj graph panel's statechart: whether the panel has the keyboard, which
// mode it is in, which section it shows and which row is selected. The desktop
// app (gui.tsx) and the TUI (tui.tsx) both run it, one actor per panel.
//
// Each mode state carries its own name and keys in `meta`, so the mode line
// and the hint line are read from the state the panel is in, and a key is
// shown enabled exactly when the machine would take its event.
//
// The cursor follows a row's key (a change id, a step, an operation), not its
// position: when the agent's dry run adds a change above the selection, the
// selection stays on the change it was on, and an open detail keeps showing
// the row it was opened on. If that row goes away, the detail closes.
import { setup, types } from "xstate"

export type SectionID = "graph" | "plan" | "jjr" | "ops"
export const SECTIONS: readonly SectionID[] = ["graph", "plan", "jjr", "ops"]
export const TITLES: Readonly<Record<SectionID, string>> = { graph: "Graph", plan: "Plan", jjr: "jjr", ops: "Ops" }

/**
 * Where the panel is drawn: the desktop app's side region, the TUI's session
 * panel, or the TUI screen it takes outside a session. Only the TUI closes the
 * view with a key, and only its session panel can go full screen.
 */
export type Surface = "gui" | "panel" | "screen"

export type Rows = Readonly<Record<SectionID, readonly string[]>>
const NO_ROWS: Rows = { graph: [], plan: [], jjr: [], ops: [] }

export interface ViewContext {
  readonly surface: Surface
  readonly section: SectionID
  /** Each section's row keys, top to bottom. */
  readonly rows: Rows
  /** Each section's selected row key; a section without one selects its first row. */
  readonly cursor: Readonly<Partial<Record<SectionID, string>>>
}

export type ViewEvent =
  | { type: "FOCUS" }
  | { type: "BLUR" }
  | { type: "ROWS"; rows: Rows; wc: string | null }
  | { type: "MOVE"; by: number }
  | { type: "FIRST" }
  | { type: "LAST" }
  | { type: "PICK"; key: string }
  | { type: "NEXT_SECTION" }
  | { type: "PREV_SECTION" }
  | { type: "SHOW"; section: SectionID }
  | { type: "OPEN" }
  | { type: "BACK" }
  | { type: "SCROLL"; by: number }
  | { type: "COPY" }
  | { type: "REFRESH" }
  | { type: "FULLSCREEN" }
  | { type: "CLOSE" }

/** A key and the event it sends; each mode state lists its keys in `meta.keys`. */
export interface Binding {
  readonly event: ViewEvent
  /** `KeyboardEvent.key` values, for the desktop app. */
  readonly gui: readonly string[]
  /** An OpenTUI bind string, for the TUI. */
  readonly tui: string
  /** The TUI command title. */
  readonly title: string
  /** Shown in the hint line as `hint label`; a key without one shares another's, as k shares j/k. */
  readonly hint?: string
  readonly label?: string
  /** The surfaces that have the key; all of them when absent. */
  readonly surfaces?: readonly Surface[]
}

/** What each mode state declares: the name the mode line shows and the keys that work in it. */
export interface ModeMeta {
  readonly mode: "NORMAL" | "DETAIL"
  readonly keys: readonly Binding[]
}

const NORMAL_KEYS: readonly Binding[] = [
  { event: { type: "MOVE", by: 1 }, gui: ["j", "ArrowDown"], tui: "j,down", title: "Next row", hint: "j/k", label: "move" },
  { event: { type: "MOVE", by: -1 }, gui: ["k", "ArrowUp"], tui: "k,up", title: "Previous row" },
  { event: { type: "FIRST" }, gui: ["g", "Home"], tui: "g,home", title: "First row" },
  { event: { type: "LAST" }, gui: ["G", "End"], tui: "shift+g,end", title: "Last row" },
  {
    event: { type: "NEXT_SECTION" },
    gui: ["l", "ArrowRight", "Tab"],
    tui: "l,right,tab",
    title: "Next section",
    hint: "h/l",
    label: "section",
  },
  { event: { type: "PREV_SECTION" }, gui: ["h", "ArrowLeft"], tui: "h,left", title: "Previous section" },
  ...SECTIONS.map(
    (section, position): Binding => ({
      event: { type: "SHOW", section },
      gui: [String(position + 1)],
      tui: String(position + 1),
      title: `Show ${TITLES[section]}`,
    }),
  ),
  { event: { type: "OPEN" }, gui: ["Enter"], tui: "return", title: "Show details", hint: "⏎", label: "details" },
  { event: { type: "COPY" }, gui: ["y"], tui: "y", title: "Copy the change id, step, fix or operation", hint: "y", label: "copy" },
  { event: { type: "REFRESH" }, gui: ["r"], tui: "r", title: "Read the repository again", hint: "r", label: "refresh" },
  {
    event: { type: "FULLSCREEN" },
    gui: [],
    tui: "f",
    title: "Toggle full screen",
    hint: "f",
    label: "full screen",
    surfaces: ["panel"],
  },
  {
    event: { type: "CLOSE" },
    gui: [],
    tui: "escape,q",
    title: "Close the jj graph view",
    hint: "esc",
    label: "close",
    surfaces: ["panel", "screen"],
  },
]

const DETAIL_KEYS: readonly Binding[] = [
  { event: { type: "SCROLL", by: 1 }, gui: ["j", "ArrowDown"], tui: "j,down", title: "Scroll down", hint: "j/k", label: "scroll" },
  { event: { type: "SCROLL", by: -1 }, gui: ["k", "ArrowUp"], tui: "k,up", title: "Scroll up" },
  { event: { type: "COPY" }, gui: ["y"], tui: "y", title: "Copy the change id, step, fix or operation", hint: "y", label: "copy" },
  { event: { type: "BACK" }, gui: ["Escape", "Enter", "q"], tui: "escape,return,q", title: "Back to the list", hint: "esc", label: "back" },
]

const clamp = (value: number, length: number) => Math.min(Math.max(value, 0), Math.max(length - 1, 0))

/** The selected row's position in a section: its key's position, or the first row. */
export function cursorIndex(context: ViewContext, section: SectionID = context.section) {
  const index = context.cursor[section] === undefined ? -1 : context.rows[section].indexOf(context.cursor[section])
  return index < 0 ? 0 : index
}

/** The selected row's key in the current section, if the section has rows. */
export function selectedKey(context: ViewContext): string | undefined {
  return context.rows[context.section][cursorIndex(context)]
}

/** The cursor moved to a position in the current section. */
function moveTo(context: ViewContext, index: number) {
  const keys = context.rows[context.section]
  const key = keys[clamp(index, keys.length)]
  return key === undefined ? context.cursor : { ...context.cursor, [context.section]: key }
}

/**
 * Cursors for new rows: a row still there stays selected; a row that went away
 * hands the selection to whatever took its place; the graph starts on the
 * working copy.
 */
export function follow(context: ViewContext, rows: Rows, wc: string | null) {
  const cursor: Partial<Record<SectionID, string>> = {}
  for (const section of SECTIONS) {
    const keys = rows[section]
    const was = context.cursor[section]
    if (was !== undefined && keys.includes(was)) cursor[section] = was
    else if (was !== undefined && keys.length > 0) cursor[section] = keys[clamp(cursorIndex(context, section), keys.length)]
    else if (section === "graph" && wc !== null && keys.includes(wc)) cursor[section] = wc
  }
  return cursor
}

const next = (section: SectionID, offset: number) =>
  SECTIONS[(SECTIONS.indexOf(section) + offset + SECTIONS.length) % SECTIONS.length]

export const viewMachine = setup({
  schemas: {
    context: types<ViewContext>(),
    input: types<{ surface: Surface; section?: SectionID }>(),
    /** A mode state's name and keys. */
    meta: types<ModeMeta>(),
    events: {
      /** The panel got or lost the keyboard. */
      FOCUS: types<{}>(),
      BLUR: types<{}>(),
      /** The rows changed: each section's row keys, and the working copy's. */
      ROWS: types<{ rows: Rows; wc: string | null }>(),
      MOVE: types<{ by: number }>(),
      FIRST: types<{}>(),
      LAST: types<{}>(),
      /** A row was clicked: select it, or open it when it is already selected. */
      PICK: types<{ key: string }>(),
      NEXT_SECTION: types<{}>(),
      PREV_SECTION: types<{}>(),
      SHOW: types<{ section: SectionID }>(),
      OPEN: types<{}>(),
      BACK: types<{}>(),
      SCROLL: types<{ by: number }>(),
      COPY: types<{}>(),
      REFRESH: types<{}>(),
      FULLSCREEN: types<{}>(),
      CLOSE: types<{}>(),
    },
    emitted: {
      /** Copy the selected row's text. */
      copy: types<{ section: SectionID; key: string }>(),
      /** Scroll the open detail. */
      scroll: types<{ by: number }>(),
      refresh: types<{}>(),
      fullscreen: types<{}>(),
      close: types<{}>(),
    },
  },
}).createMachine({
  id: "graphView",
  description: "The jj graph panel: keyboard focus, mode, section and selection.",
  context: ({ input }) => ({ surface: input.surface, section: input.section ?? "graph", rows: NO_ROWS, cursor: {} }),
  type: "parallel",
  states: {
    focus: {
      description: "Keys reach the panel only while it has focus; until then the prompt has them.",
      initial: "prompt",
      states: {
        prompt: { on: { FOCUS: { target: "focused" } } },
        focused: { on: { BLUR: { target: "prompt" } } },
      },
    },
    mode: {
      initial: "normal",
      on: {
        // Showing a section always starts in its list.
        NEXT_SECTION: ({ context }) => ({ target: ".normal", context: { section: next(context.section, 1) } }),
        PREV_SECTION: ({ context }) => ({ target: ".normal", context: { section: next(context.section, -1) } }),
        SHOW: ({ event }) => ({ target: ".normal", context: { section: event.section } }),
        ROWS: ({ context, event }) => ({ context: { rows: event.rows, cursor: follow(context, event.rows, event.wc) } }),
        // Conditions and targets stay single expressions with literal targets,
        // so Stately's source import projects every branch onto the graph.
        COPY: ({ context }, enq) => {
          if (selectedKey(context) === undefined) return
          enq.emit({ type: "copy", section: context.section, key: selectedKey(context) ?? "" })
          return {}
        },
      },
      states: {
        normal: {
          description: "Moving through a section's rows.",
          meta: { mode: "NORMAL", keys: NORMAL_KEYS } satisfies ModeMeta,
          on: {
            MOVE: ({ context, event }) => ({ context: { cursor: moveTo(context, cursorIndex(context) + event.by) } }),
            FIRST: ({ context }) => ({ context: { cursor: moveTo(context, 0) } }),
            LAST: ({ context }) => ({ context: { cursor: moveTo(context, context.rows[context.section].length - 1) } }),
            PICK: ({ context, event }) => {
              if (!context.rows[context.section].includes(event.key)) return
              if (selectedKey(context) === event.key) return { target: "detail" }
              return { context: { cursor: { ...context.cursor, [context.section]: event.key } } }
            },
            OPEN: ({ context }) => {
              if (selectedKey(context) === undefined) return
              return { target: "detail" }
            },
            REFRESH: (_, enq) => {
              enq.emit({ type: "refresh" })
              return {}
            },
            FULLSCREEN: ({ context }, enq) => {
              if (context.surface !== "panel") return
              enq.emit({ type: "fullscreen" })
              return {}
            },
            CLOSE: ({ context }, enq) => {
              if (context.surface === "gui") return
              enq.emit({ type: "close" })
              return {}
            },
          },
        },
        detail: {
          description: "Reading the selected row.",
          meta: { mode: "DETAIL", keys: DETAIL_KEYS } satisfies ModeMeta,
          on: {
            BACK: { target: "normal" },
            SCROLL: ({ event }, enq) => {
              enq.emit({ type: "scroll", by: event.by })
              return {}
            },
            // The detail shows the row it was opened on; when that row goes away, back to the list.
            ROWS: ({ context, event }) =>
              event.rows[context.section].includes(selectedKey(context) ?? "")
                ? { context: { rows: event.rows, cursor: follow(context, event.rows, event.wc) } }
                : { target: "normal", context: { rows: event.rows, cursor: follow(context, event.rows, event.wc) } },
          },
        },
      },
    },
  },
})

/** One line of the hint bar: a key, what it does, and whether the machine would take it now. */
export interface Hint {
  readonly hint: string
  readonly label: string
  readonly enabled: boolean
  readonly binding: Binding
}

interface ViewSnapshot {
  readonly context: ViewContext
  matches(value: unknown): boolean
  can(event: ViewEvent): boolean
  getMeta(): Record<string, unknown>
}

/** The active mode state's declaration. */
export function modeMeta(snapshot: ViewSnapshot): ModeMeta {
  const meta = snapshot.getMeta()
  return (meta["graphView.mode.detail"] ?? meta["graphView.mode.normal"]) as ModeMeta
}

/** The mode line's label: PROMPT while the panel does not have the keyboard, else the mode's name. */
export function badge(snapshot: ViewSnapshot): "PROMPT" | ModeMeta["mode"] {
  return snapshot.matches({ focus: "prompt" }) ? "PROMPT" : modeMeta(snapshot).mode
}

/** The keys of the current mode on this surface, in the order they are declared. */
export function bindings(snapshot: ViewSnapshot): Binding[] {
  const surface = snapshot.context.surface
  return modeMeta(snapshot).keys.filter((binding) => binding.surfaces === undefined || binding.surfaces.includes(surface))
}

/** The hint line: one entry per key that declares a hint, enabled when the machine would take its event. */
export function hints(snapshot: ViewSnapshot): Hint[] {
  return bindings(snapshot).flatMap((binding) =>
    binding.hint === undefined
      ? []
      : [{ hint: binding.hint, label: binding.label ?? binding.title, enabled: snapshot.can(binding.event), binding }],
  )
}
