// xstate-version: 6
//
// One directory's jj graph as a front end sees it: the statechart that reads
// `State` through the jj-graph RPC (rpc.ts), follows its `changed` events, and
// says what to show while there is nothing to show. The desktop app (gui.tsx)
// and the TUI (tui.tsx) both run it, one actor per directory.
//
// It replaces two hand-rolled loaders that had drifted apart: the desktop one
// let reads overlap, so an older answer could land after a newer one, and the
// TUI one could put a graph back on screen after jj-graph had said it could no
// longer read the repository. Here one read runs at a time, a change that
// arrives during a read makes the read stale and starts another when it ends,
// and leaving `loading` stops the read, so a late answer is never applied.
import { createCallbackLogic, setup, types } from "xstate"
import * as M from "./model"

/** Reads in a row that may find the location's server plugin still starting. */
export const RETRIES = 8
/** How long to wait after the nth such read before the next one. */
export const backoff = (attempt: number) => 500 * attempt

/** How a front end reaches one directory: the jj-graph RPC's two methods, already bound to it. */
export interface SourceClient {
  state(signal: AbortSignal): Promise<M.State>
  refresh(): Promise<unknown>
}

export interface SourceContext {
  /** The last graph read. Kept while a newer one loads; dropped when jj-graph goes away. */
  readonly state: M.State | null
  /** What a sidebar shows: the latest `changed` summary, or the summary of the graph read. */
  readonly summary: M.Summary | null
  /** Why jj-graph cannot read the repository, while it cannot. */
  readonly reason: string | null
  /** The last unexpected failure of a read, until one succeeds. */
  readonly error: string | null
  /** Reads in a row that found the location's server plugin not started yet. */
  readonly attempt: number
}

/** What the read actor reports, one event per outcome. */
export type ReadOutcome =
  | { readonly type: "LOADED"; readonly state: M.State }
  | { readonly type: "BOOTING" }
  | { readonly type: "UNAVAILABLE"; readonly reason: string }
  | { readonly type: "FAILED"; readonly message: string }

/** Sort a failed read: the location still starting, jj-graph unable to read, or anything else. */
export function classify(caught: unknown): Exclude<ReadOutcome, { type: "LOADED" }> {
  const failure = caught as { type?: string; message?: string; data?: { reason?: string } } | undefined
  // A location boots its server plugins on first use, so the method is briefly missing.
  if (failure?.type === "rpc.unavailable" || failure?.type === "rpc.method_not_found") return { type: "BOOTING" }
  if (failure?.type === "unavailable")
    return { type: "UNAVAILABLE", reason: failure.data?.reason ?? failure.message ?? "unavailable" }
  return { type: "FAILED", message: failure?.message ?? String(caught) }
}

/** A `changed` event's payload as the event this machine takes. */
export function changed(summary: M.Published): { type: "CHANGED"; summary: M.Summary } | { type: "UNAVAILABLE"; reason: string } {
  return M.isUnavailable(summary) ? { type: "UNAVAILABLE", reason: summary.unavailable } : { type: "CHANGED", summary }
}

/** One read of the directory's state. Stopping it aborts the call and drops its answer. */
export const reader = (client: SourceClient) =>
  createCallbackLogic(({ sendBack }) => {
    const controller = new AbortController()
    client.state(controller.signal).then(
      (state) => {
        if (!controller.signal.aborted) sendBack({ type: "LOADED", state })
      },
      (caught) => {
        if (!controller.signal.aborted) sendBack(classify(caught))
      },
    )
    return () => controller.abort()
  })

/** Ask the server plugin to re-read the repository; the outcome does not matter, a read follows. */
export const refresher = (client: SourceClient) =>
  createCallbackLogic(({ sendBack }) => {
    let stopped = false
    void client
      .refresh()
      .catch(() => undefined)
      .then(() => {
        if (!stopped) sendBack({ type: "REFRESHED" })
      })
    return () => {
      stopped = true
    }
  })

// Until a front end connects the machine to a directory with `connect`.
const unconnected: SourceClient = {
  state: () => Promise.reject(new Error("jj-graph source is not connected to a directory")),
  refresh: () => Promise.resolve(),
}

export const sourceMachine = setup({
  schemas: {
    context: types<SourceContext>(),
    events: {
      /** The server plugin published a new summary for this directory. */
      CHANGED: types<{ summary: M.Summary }>(),
      /** jj-graph cannot read the repository: published, or the answer to a read. */
      UNAVAILABLE: types<{ reason: string }>(),
      /** The person asked to read the repository again. */
      REFRESH: types<{}>(),
      LOADED: types<{ state: M.State }>(),
      BOOTING: types<{}>(),
      FAILED: types<{ message: string }>(),
      REFRESHED: types<{}>(),
    },
  },
  actors: { read: reader(unconnected), refresh: refresher(unconnected) },
  delays: { backoff: ({ context }) => backoff(context.attempt) },
}).createMachine({
  id: "graphSource",
  description: "One directory's jj graph, read through the jj-graph RPC and kept current by its changed events.",
  context: { state: null, summary: null, reason: null, error: null, attempt: 0 },
  initial: "loading",
  on: {
    // Wherever it is, jj-graph saying it cannot read the repository wins, and a read in flight is dropped.
    UNAVAILABLE: ({ event }) => ({ target: ".unavailable", context: { state: null, reason: event.reason } }),
    REFRESH: { target: ".refreshing" },
  },
  states: {
    loading: {
      description: "One read is in flight.",
      tags: ["busy"],
      invoke: { id: "read", src: "read" },
      initial: "current",
      states: {
        current: {
          description: "Nothing changed since the read started.",
          on: {
            CHANGED: ({ event }) => ({ target: "stale", context: { summary: event.summary, attempt: 0 } }),
            LOADED: ({ event }) => ({
              target: "#graphSource.ready",
              context: { state: event.state, summary: M.summarize(event.state), reason: null, error: null, attempt: 0 },
            }),
            BOOTING: ({ context }) =>
              context.attempt < RETRIES
                ? { target: "#graphSource.waiting", context: { attempt: context.attempt + 1 } }
                : { target: "#graphSource.absent" },
            FAILED: ({ event }) => ({ target: "#graphSource.failed", context: { error: event.message } }),
          },
        },
        stale: {
          description: "The repository changed while the read was in flight: whatever it returns, read again.",
          on: {
            CHANGED: ({ event }) => ({ context: { summary: event.summary } }),
            LOADED: ({ event }) => ({
              target: "#graphSource.loading",
              reenter: true,
              context: { state: event.state, summary: M.summarize(event.state), reason: null, error: null },
            }),
            BOOTING: { target: "#graphSource.loading", reenter: true },
            FAILED: { target: "#graphSource.loading", reenter: true },
          },
        },
      },
    },
    waiting: {
      description: "The location's server plugin had not started; ask again after a backoff.",
      tags: ["busy"],
      after: { backoff: { target: "loading" } },
      on: {
        CHANGED: ({ event }) => ({ target: "loading", context: { summary: event.summary, attempt: 0 } }),
      },
    },
    ready: {
      description: "Showing the latest graph.",
      on: {
        CHANGED: ({ event }) => ({ target: "loading", context: { summary: event.summary } }),
      },
    },
    unavailable: {
      description: "jj-graph is running here but cannot read the repository.",
      on: {
        CHANGED: ({ event }) => ({ target: "loading", context: { summary: event.summary, reason: null } }),
      },
    },
    absent: {
      description: "jj-graph does not run here: not a jj repository, or the plugin is off.",
      on: {
        CHANGED: ({ event }) => ({ target: "loading", context: { summary: event.summary, attempt: 0 } }),
      },
    },
    failed: {
      description: "A read failed unexpectedly; the last graph, if any, stays on screen.",
      on: {
        CHANGED: ({ event }) => ({ target: "loading", context: { summary: event.summary } }),
      },
    },
    refreshing: {
      description: "Asking the server plugin to re-read the repository before reading it.",
      tags: ["busy"],
      invoke: { id: "refresh", src: "refresh" },
      on: {
        REFRESH: undefined,
        REFRESHED: { target: "loading" },
        CHANGED: ({ event }) => ({ context: { summary: event.summary } }),
      },
    },
  },
})

/** The machine bound to one directory's client. */
export const connect = (client: SourceClient) =>
  sourceMachine.provide({ actors: { read: reader(client), refresh: refresher(client) } })

/** What a `changed` event would have carried: the summary, or why jj-graph cannot read. */
export function published(snapshot: { matches(value: "unavailable"): boolean; context: SourceContext }): M.Published | undefined {
  if (snapshot.matches("unavailable")) return { unavailable: snapshot.context.reason ?? "unavailable" }
  return snapshot.context.summary ?? undefined
}
