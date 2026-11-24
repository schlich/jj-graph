// What jj-graph's state means for a reader: the summary a sidebar shows, and
// the rows of the graph, plan, diagnostics and operation views. Pure, shared by
// the server, the TUI and the desktop app, and tested by model.test.ts.
import { layout } from "./layout.js"

export interface Edge {
  readonly to: string | null
  readonly parent: string
  readonly indirect: boolean
}

export interface Node {
  readonly change: string
  readonly id: string
  readonly prefix: string
  readonly description: string
  readonly author: string
  readonly time: string
  readonly wc: boolean
  readonly conflict: boolean
  readonly divergent: boolean
  readonly empty: boolean
  readonly hidden: boolean
  readonly immutable: boolean
  readonly files: number
  readonly paths: readonly string[]
  readonly bookmarks: readonly { readonly name: string; readonly conflict?: boolean }[]
  readonly remotes: readonly string[]
  readonly tags: readonly string[]
  readonly workspaces: readonly string[]
  readonly edges: readonly Edge[]
  readonly parents: readonly string[]
}

export interface Diagnostic {
  readonly code: string
  readonly severity: "error" | "warning" | "info"
  readonly message: string
  readonly suggestedCommand?: string | null
  readonly affectedChanges?: readonly string[]
}

export interface Op {
  readonly id: string
  readonly description: string
  readonly time: string
  readonly snapshot?: boolean
}

export interface State {
  readonly repo: string
  readonly revset: string
  readonly defaultRevset: string
  readonly head: string
  readonly viewing: string | null
  readonly truncated: boolean
  readonly nodes: readonly Node[]
  readonly ops: readonly Op[]
  readonly baseline: Readonly<Record<string, string>> | null
  readonly touched: readonly string[]
  readonly rewound: boolean
  readonly jjr: {
    readonly summary: {
      readonly shape: string
      readonly status: string
      readonly mutableCount: number
      readonly conflictedCount: number
      readonly divergentCount: number
    }
    readonly diagnostics: readonly Diagnostic[]
    readonly verification: Readonly<Record<string, string>>
  }
  readonly dry: {
    readonly active: boolean
    readonly base: string | null
    readonly stale: string | null
    readonly steps: readonly { readonly label: string; readonly output: string }[]
    readonly redo: readonly string[]
  }
}

export type Tone = "ok" | "warn" | "error" | "busy" | "idle"

export const glyph: Readonly<Record<Tone, string>> = {
  ok: "●",
  warn: "▲",
  error: "✖",
  busy: "◐",
  idle: "·",
}

export interface Summary {
  readonly repo: string
  readonly head: string
  readonly workingCopy?: {
    readonly change: string
    readonly prefix: string
    readonly title: string
    readonly files: number
    readonly empty: boolean
    readonly conflict: boolean
    readonly bookmarks: readonly string[]
  }
  readonly mutable: number
  readonly conflicted: number
  readonly divergent: number
  readonly shape: string
  readonly status: string
  readonly diagnostics: { readonly errors: number; readonly warnings: number; readonly info: number }
  readonly plan: {
    readonly active: boolean
    readonly steps: readonly string[]
    readonly redo: number
    readonly stale: string | null
  }
  /** The worst thing in it: an error diagnostic or conflict, a stale plan, an open plan, or nothing. */
  readonly tone: Tone
}

/** What a `changed` event carries: the summary, or why jj-graph cannot read the repository. */
export type Published = Summary | { readonly unavailable: string }

export const isUnavailable = (value: Published | undefined): value is { readonly unavailable: string } =>
  value !== undefined && "unavailable" in value

export const short = (id: string, n = 8) => id.slice(0, n)
export const title = (description: string) => description.split("\n", 1)[0]?.trim() || "(no description)"

export function summarize(state: State): Summary {
  const wc = state.nodes.find((node) => node.wc)
  const count = (severity: Diagnostic["severity"]) =>
    state.jjr.diagnostics.filter((d) => d.severity === severity).length
  const diagnostics = { errors: count("error"), warnings: count("warning"), info: count("info") }
  const sum = state.jjr.summary
  const plan = {
    active: state.dry.active,
    steps: state.dry.steps.map((step) => step.label),
    redo: state.dry.redo.length,
    stale: state.dry.stale,
  }
  const tone: Tone =
    diagnostics.errors > 0 || sum.conflictedCount > 0 || (wc?.conflict ?? false)
      ? "error"
      : plan.stale || diagnostics.warnings > 0 || sum.divergentCount > 0
        ? "warn"
        : plan.active
          ? "busy"
          : "ok"
  return {
    repo: state.repo,
    head: state.head,
    ...(wc
      ? {
          workingCopy: {
            change: wc.change,
            prefix: wc.prefix,
            title: title(wc.description),
            files: wc.files,
            empty: wc.empty,
            conflict: wc.conflict,
            bookmarks: wc.bookmarks.map((b) => b.name),
          },
        }
      : {}),
    mutable: sum.mutableCount,
    conflicted: sum.conflictedCount,
    divergent: sum.divergentCount,
    shape: sum.shape,
    status: sum.status,
    diagnostics,
    plan,
    tone,
  }
}

/** One line per fact, for a sidebar: what the working copy is, the stack, the plan, and jjr's verdict. */
export interface SummaryLine {
  readonly key: "wc" | "stack" | "plan" | "jjr"
  readonly label: string
  readonly text: string
  readonly tone: Tone
}

export function summaryLines(summary: Summary): SummaryLine[] {
  const lines: SummaryLine[] = []
  const wc = summary.workingCopy
  if (wc) {
    const what = wc.conflict ? "conflicted" : wc.empty ? "empty" : `${wc.files} file${wc.files === 1 ? "" : "s"}`
    lines.push({
      key: "wc",
      label: "@",
      text: `${short(wc.change)} ${wc.title} · ${what}`,
      tone: wc.conflict ? "error" : "idle",
    })
  }
  const stack = [`${summary.mutable} mutable`]
  if (summary.conflicted) stack.push(`${summary.conflicted} conflicted`)
  if (summary.divergent) stack.push(`${summary.divergent} divergent`)
  lines.push({
    key: "stack",
    label: "stack",
    text: `${summary.shape} · ${stack.join(" · ")}`,
    tone: summary.conflicted ? "error" : summary.divergent ? "warn" : "ok",
  })
  if (summary.plan.stale)
    lines.push({ key: "plan", label: "plan", text: `stale: ${summary.plan.stale}`, tone: "warn" })
  else if (summary.plan.active)
    lines.push({
      key: "plan",
      label: "plan",
      text: `dry run, ${summary.plan.steps.length} step${summary.plan.steps.length === 1 ? "" : "s"}: ${summary.plan.steps.at(-1) ?? ""}`,
      tone: "busy",
    })
  const d = summary.diagnostics
  const counts = [d.errors && `${d.errors} error`, d.warnings && `${d.warnings} warning`, d.info && `${d.info} info`]
    .filter(Boolean)
    .join(" · ")
  lines.push({
    key: "jjr",
    label: "jjr",
    text: `${summary.status}${counts ? ` · ${counts}` : ""}`,
    tone: d.errors ? "error" : d.warnings ? "warn" : "ok",
  })
  return lines
}

/** A row of any view: what the list shows, and what its detail view and copy key give. */
export interface Row {
  readonly key: string
  readonly tone: Tone
  /** The graph lanes on either side of the glyph, in the graph view only. */
  readonly lanes?: Lanes
  readonly glyph?: string
  readonly label: string
  readonly detail?: string
  /** Shown when the row is opened. */
  readonly lines: readonly string[]
  /** What the copy key copies. */
  readonly copy: string
}

/** A row's lanes: `before` ends where the glyph goes, `after` starts right after it. */
export interface Lanes {
  readonly before: string
  readonly after: string
}

/**
 * The lanes of `jj log`, from jj-graph's own web layout: one column per line of
 * development, two characters wide, with `│` (`╎` for an elided ancestry) where
 * an edge passes a row and the node's glyph in its own lane.
 */
export function lanes(nodes: readonly Node[]): Lanes[] {
  const { pos, edges } = layout(
    nodes.map((node) => ({ id: node.id, edges: [...node.edges] })),
    () => 1,
  )
  const width = Math.max(0, ...[...pos.values()].map((p) => p.lane), ...edges.map((e) => e.track)) + 1
  const grid = nodes.map(() => Array<string>(width).fill(" "))
  for (const edge of edges) {
    const from = pos.get(edge.from)?.row
    if (from === undefined) continue
    const to = edge.to === null ? nodes.length : (pos.get(edge.to)?.row ?? nodes.length)
    for (let row = from + 1; row < to; row++) grid[row][edge.track] = edge.indirect ? "╎" : "│"
  }
  return nodes.map((node, row) => {
    const lane = pos.get(node.id)?.lane ?? 0
    const cells = grid[row].map((cell) => `${cell} `)
    return {
      before: cells.slice(0, lane).join(""),
      after: (" " + cells.slice(lane + 1).join("")).replace(/\s+$/, ""),
    }
  })
}

export function nodeGlyph(node: Node) {
  return node.wc ? "@" : node.conflict ? "×" : node.immutable ? "◆" : "○"
}

export function graphRows(state: State): Row[] {
  const touched = new Set(state.touched)
  const byCommit = new Map(state.nodes.map((node) => [node.id, node]))
  const drawn = lanes(state.nodes)
  return state.nodes.map((node, index) => {
    const was = state.baseline?.[node.change]
    const refs = [
      ...node.bookmarks.map((b) => `${b.name}${b.conflict ? "??" : ""}`),
      ...node.remotes,
      ...node.tags.map((t) => `tag:${t}`),
      ...node.workspaces.map((w) => `${w}@`),
    ]
    const flags: string[] = []
    if (node.conflict) flags.push("conflict")
    if (node.divergent) flags.push("divergent")
    if (node.hidden) flags.push("hidden")
    if (node.empty) flags.push("empty")
    else if (!node.immutable && node.files > 0) flags.push(`${node.files} file${node.files === 1 ? "" : "s"}`)
    if (touched.has(node.change)) flags.push("edited by plan")
    else if (was !== undefined && was !== node.id) flags.push("auto-rebased")
    if (state.baseline && was === undefined) flags.push("new")
    const verified = state.jjr.verification[node.change]
    if (verified && verified !== "unknown") flags.push(verified)
    const parents = node.edges.map((edge) =>
      edge.to === null ? "(outside revset)" : short(byCommit.get(edge.to)?.change ?? edge.to),
    )
    const tone: Tone = node.conflict
      ? "error"
      : node.divergent
        ? "warn"
        : touched.has(node.change)
          ? "busy"
          : node.immutable
            ? "idle"
            : "ok"
    return {
      key: node.change,
      tone,
      lanes: drawn[index],
      glyph: nodeGlyph(node),
      label: `${short(node.change)} ${title(node.description)}`,
      detail: [refs.length ? `[${refs.join(", ")}]` : "", flags.length ? `(${flags.join(", ")})` : ""]
        .filter(Boolean)
        .join(" "),
      lines: [
        `change ${node.change}`,
        `commit ${node.id}${was !== undefined && was !== node.id ? ` (was ${short(was, 12)})` : ""}`,
        `author ${node.author} · ${node.time}`,
        ...(refs.length ? [`refs ${refs.join(", ")}`] : []),
        ...(flags.length ? [`state ${flags.join(", ")}`] : []),
        ...(parents.length ? [`parents ${parents.join(", ")}`] : []),
        "",
        ...node.description.trimEnd().split("\n"),
        ...(node.paths.length ? ["", ...node.paths.map((p) => `  ${p}`)] : []),
      ],
      copy: node.change,
    }
  })
}

export function planRows(state: State): Row[] {
  const rows: Row[] = state.dry.steps.map((step, index) => ({
    key: `step-${index}`,
    tone: "busy",
    label: `${index + 1}. ${step.label}`,
    lines: [step.label, "", ...(step.output ? step.output.split("\n") : ["(no output)"])],
    copy: step.label,
  }))
  if (state.dry.stale)
    rows.unshift({
      key: "stale",
      tone: "warn",
      label: `stale: ${state.dry.stale}`,
      lines: [state.dry.stale, "", "Undo that step or discard the plan; apply_plan is refused until then."],
      copy: state.dry.stale,
    })
  state.dry.redo
    .slice()
    .reverse()
    .forEach((label, index) =>
      rows.push({ key: `redo-${index}`, tone: "idle", label: `redo: ${label}`, lines: [label], copy: label }),
    )
  return rows
}

export function diagnosticRows(state: State): Row[] {
  const tone = (severity: Diagnostic["severity"]): Tone =>
    severity === "error" ? "error" : severity === "warning" ? "warn" : "idle"
  return state.jjr.diagnostics.map((d, index) => ({
    key: `${d.code}-${index}`,
    tone: tone(d.severity),
    label: d.message,
    detail: d.code,
    lines: [
      `${d.severity} ${d.code}`,
      "",
      d.message,
      ...(d.affectedChanges?.length ? ["", `changes ${d.affectedChanges.map((c) => short(c)).join(", ")}`] : []),
      ...(d.suggestedCommand ? ["", `fix: ${d.suggestedCommand}`] : []),
    ],
    copy: d.suggestedCommand ?? d.message,
  }))
}

export function opRows(state: State): Row[] {
  return state.ops.map((op) => ({
    key: op.id,
    tone: op.id === state.head ? "ok" : "idle",
    label: `${short(op.id, 12)} ${op.description}`,
    detail: op.time,
    lines: [`operation ${op.id}`, op.time, "", op.description],
    copy: op.id,
  }))
}

/** A heading for the views: which revisions, and whether the graph is the live one or the plan's preview. */
export function heading(state: State) {
  if (state.viewing) return `operation ${short(state.viewing, 12)} (looking back)`
  if (state.dry.active) return `dry run · ${state.dry.steps.length} step(s) on ${short(state.dry.base ?? "", 12)}`
  return `live · ${short(state.head, 12)}`
}
