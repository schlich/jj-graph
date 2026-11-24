// OpenCode 2 server plugin for jj-graph. In every directory inside a Jujutsu
// repository it runs one `jj-graph mcp` process, gives the agent its tools as
// native OpenCode tools (`jj-graph_dry_run`, ...), and publishes what that
// process sees, the graph, jjr's reading of it and the agent's dry-run plan,
// to OpenCode's front ends through the `jj-graph` RPC (rpc.ts).
//
// Options (from the `plugins` entry in opencode.json):
//   command        jj-graph executable (default: `jj-graph` on PATH; the Nix
//                  package substitutes its own store path)
//   verifyCommand  passed to `jj-graph mcp --verify-command`, for verify_stack
//   codemode       expose the tools through Code Mode (OpenCode's default: true)
//
// A directory outside a Jujutsu repository gets nothing. When configuration
// already has an `mcp.servers.jj-graph` entry, that server keeps the tools and
// the views show the repository without the agent's plan.
import { existsSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs"
import path from "node:path"
import { Plugin } from "@opencode/plugin"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import { Engine, EngineError, type McpTool } from "./engine"
import { summarize, type State } from "./model"
import { JjGraph } from "./rpc"

const NAMESPACE = "jj-graph"
const DEFAULT_COMMAND = "jj-graph"
// Coalesce bursts: an agent's edits, jj's own operation writes.
const SETTLE_MS = 250

export default Plugin.define({
  id: "jj-graph",
  async setup(ctx) {
    const directory = ctx.location.directory
    const root = jjWorkspaceRoot(directory)
    if (!root) return

    const options = ctx.options as Record<string, unknown>
    const command = stringOption(options, "command") ?? DEFAULT_COMMAND
    const verify = stringOption(options, "verifyCommand")
    const codemode = typeof options.codemode === "boolean" ? options.codemode : undefined
    const engine = new Engine(
      command,
      ["mcp", directory, ...(verify ? ["--verify-command", verify] : [])],
      directory,
    )

    // The latest state, its version, and why there is none when jj-graph is down.
    let current: { state: State; version: string } | undefined
    let unavailable: string | undefined
    let reading: Promise<void> | undefined
    let again = false
    let disposed = false
    // The tools and instructions jj-graph announces; empty until it first starts.
    let tools: McpTool[] = []
    let instructions = ""
    let configured = false

    async function discover() {
      try {
        instructions = (await engine.start()).instructions
        tools = await engine.tools()
      } catch (error) {
        unavailable = message(error)
      }
    }

    const registration = await ctx.rpc.register(JjGraph, {
      state: async (input, context) => {
        const revset = (input as { revset?: string } | undefined)?.revset
        if (revset) {
          try {
            return await engine.state(revset)
          } catch (error) {
            return context.error("unavailable", message(error), { reason: message(error) })
          }
        }
        if (!current) await refresh()
        if (!current) {
          const reason = unavailable ?? "jj-graph has not read the repository yet"
          return context.error("unavailable", reason, { reason })
        }
        return current.state
      },
      refresh: async () => {
        await refresh()
        return current ? { version: current.version } : { unavailable: unavailable ?? "unknown" }
      },
    })

    // Read the state once at a time; a request while reading reads once more after.
    function refresh(): Promise<void> {
      if (disposed) return Promise.resolve()
      if (reading) {
        again = true
        return reading
      }
      reading = (async () => {
        do {
          again = false
          try {
            const state = (await engine.state()) as unknown as State
            unavailable = undefined
            // jj-graph was down when the tools were registered: register them now.
            if (!configured && tools.length === 0) {
              await discover()
              if (tools.length > 0) await ctx.tool.reload()
            }
            const version = versionOf(state)
            if (version === current?.version) continue
            current = { state, version }
            await registration.events.emit("changed", { version, summary: summarize(state) as never })
          } catch (error) {
            const reason = message(error)
            if (reason !== unavailable) {
              unavailable = reason
              current = undefined
              await registration.events
                .emit("changed", { version: `unavailable:${reason}`, summary: { unavailable: reason } })
                .catch(() => undefined)
            }
          }
        } while (again && !disposed)
      })().finally(() => {
        reading = undefined
      })
      return reading
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    const soon = () => {
      if (disposed) return
      clearTimeout(timer)
      timer = setTimeout(() => void refresh(), SETTLE_MS)
    }

    // A configured jj-graph MCP server already gives the agent these tools.
    configured = await ctx.mcp
      .list()
      .then((servers) => servers.data.some((server) => server.name === NAMESPACE))
      .catch(() => false)

    if (!configured) {
      await discover()
      await ctx.tool.transform((editor) => {
        if (tools.length === 0) return
        editor.namespace({ name: NAMESPACE, description: `jj-graph for ${root}: preview jj commands, then apply them.` })
        for (const tool of tools) {
          editor.add({
            name: tool.name,
            description: tool.description ?? tool.title ?? tool.name,
            input: tool.inputSchema as never,
            options: { namespace: NAMESPACE, ...(codemode === undefined ? {} : { codemode }) },
            execute: async (input, context) => {
              // The same permission an MCP server's tool asks, so existing rules apply.
              await ctx.permission.assert({
                sessionID: context.sessionID,
                agent: context.agent,
                action: `${NAMESPACE}_${tool.name}`,
                resources: ["*"],
                save: ["*"],
                metadata: { input: input ?? {} },
              })
              let result
              try {
                result = await engine.call(tool.name, input, context.signal)
              } catch (error) {
                throw new ToolError({ message: message(error) })
              } finally {
                soon()
              }
              const text = (result.content ?? [])
                .flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
                .join("\n")
              if (result.isError) throw new ToolError({ message: text || `jj-graph ${tool.name} failed` })
              return { output: text, content: text }
            },
          })
        }
      })
      await ctx.session.hook("context", (event) => {
        if (instructions) event.system.push({ type: "text", text: `jj-graph (${root}):\n${instructions}` })
      })
    }

    // Anything else that ran, an edit or a shell, may have moved the repository.
    await ctx.tool.hook("execute.after", (event) => {
      if (!event.tool.startsWith(`${NAMESPACE}_`)) soon()
    })
    // So may jj itself, run by the user or by the agent's shell.
    const watcher = watchOperations(root, soon)

    void refresh()

    return () => {
      disposed = true
      clearTimeout(timer)
      watcher?.close()
      engine.close()
    }
  },
})

/** The nearest directory at or above `start` holding a `.jj` directory: a jj workspace root. */
export function jjWorkspaceRoot(start: string): string | undefined {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    const marker = path.join(dir, ".jj")
    if (existsSync(marker) && statSync(marker).isDirectory()) return dir
    if (path.dirname(dir) === dir) return undefined
  }
}

/** Watch the repository's operation heads, which every jj command that changes anything rewrites. */
function watchOperations(root: string, changed: () => void): FSWatcher | undefined {
  try {
    let repo = path.join(root, ".jj", "repo")
    // A secondary workspace's `.jj/repo` is a file naming the shared repository.
    if (statSync(repo).isFile()) repo = path.resolve(path.join(root, ".jj"), readFileSync(repo, "utf8").trim())
    return watch(path.join(repo, "op_heads", "heads"), () => changed())
  } catch {
    return undefined
  }
}

/** What a view would draw differently: the operation, the plan, and the revisions. */
function versionOf(state: State) {
  const plan = state.dry.steps.map((step) => step.label).join("\u0001")
  const nodes = state.nodes.map((node) => `${node.id}${node.wc ? "@" : ""}`).join(",")
  return `${state.head}|${state.dry.active}|${state.dry.stale ?? ""}|${plan}|${state.dry.redo.length}|${hash(nodes)}`
}

function hash(text: string) {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return (h >>> 0).toString(36)
}

function message(error: unknown) {
  return error instanceof EngineError || error instanceof Error ? error.message : String(error)
}

function stringOption(options: Record<string, unknown>, key: string): string | undefined {
  const value = options[key]
  return typeof value === "string" && value.trim() !== "" ? value : undefined
}
