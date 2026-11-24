// The jj-graph RPC: how the server plugin hands the repository's graph, jjr's
// reading of it, and the agent's dry-run plan to OpenCode's front ends (the
// TUI and the desktop app). Calls and events carry the location they are for.
import { Rpc } from "@opencode/plugin/rpc"

const object = { type: "object" } as const

export const JjGraph = Rpc.define({
  id: "jj-graph",
  methods: {
    /** Everything the views draw: `State` in model.ts. */
    state: {
      input: {
        type: "object",
        properties: { revset: { type: "string" } },
        additionalProperties: false,
      },
      output: object,
      errors: {
        unavailable: {
          type: "object",
          properties: { reason: { type: "string" } },
          required: ["reason"],
        },
      },
    },
    /** Re-read the repository now, as after an edit OpenCode did not see. */
    refresh: {
      input: { type: "object", additionalProperties: false },
      output: object,
    },
  },
  events: {
    /** The state moved: `Summary` in model.ts, for sidebars; fetch `state` for the rest. */
    changed: {
      schema: {
        type: "object",
        properties: {
          version: { type: "string" },
          summary: object,
        },
        required: ["version", "summary"],
      },
    },
  },
})
