// A client for one `jj-graph mcp` process: newline-delimited JSON-RPC over its
// stdin and stdout. The process holds the agent's dry-run plan, so the plugin
// keeps exactly one per directory and restarts it only after it exits.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createInterface } from "node:readline"

export interface McpTool {
  readonly name: string
  readonly title?: string
  readonly description?: string
  readonly inputSchema: Record<string, unknown>
  readonly annotations?: Record<string, unknown>
}

export interface ToolResult {
  readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }>
  readonly isError?: boolean
}

export class EngineError extends Error {}

interface Pending {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
}

const PROTOCOL = "2025-06-18"
const STDERR_LINES = 20

export class Engine {
  private child: ChildProcessWithoutNullStreams | undefined
  private ready: Promise<{ instructions: string }> | undefined
  private pending = new Map<number, Pending>()
  private next = 1
  private stderr: string[] = []
  private closed = false

  constructor(
    private readonly command: string,
    private readonly args: readonly string[],
    private readonly cwd: string,
  ) {}

  /** Start the process if it is not running, and initialize it once. */
  start(): Promise<{ instructions: string }> {
    if (this.closed) return Promise.reject(new EngineError("jj-graph engine is closed"))
    this.ready ??= this.launch()
    return this.ready
  }

  async tools(): Promise<McpTool[]> {
    await this.start()
    const result = (await this.send("tools/list", {})) as { tools?: McpTool[] }
    return result.tools ?? []
  }

  async call(name: string, args: unknown, signal?: AbortSignal): Promise<ToolResult> {
    await this.start()
    return (await this.send("tools/call", { name, arguments: args ?? {} }, signal)) as ToolResult
  }

  async state(revset?: string): Promise<Record<string, unknown>> {
    await this.start()
    return (await this.send("jj-graph/state", revset ? { revset } : {})) as Record<string, unknown>
  }

  close() {
    this.closed = true
    this.child?.kill()
    this.fail(new EngineError("jj-graph engine closed"))
  }

  private launch(): Promise<{ instructions: string }> {
    const child = spawn(this.command, [...this.args], { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"] })
    this.child = child
    this.stderr = []
    createInterface({ input: child.stdout }).on("line", (line) => this.receive(line))
    createInterface({ input: child.stderr }).on("line", (line) => {
      this.stderr.push(line)
      if (this.stderr.length > STDERR_LINES) this.stderr.shift()
    })
    const exited = new Promise<never>((_, reject) => {
      const gone = (why: string) => {
        if (this.child === child) {
          this.child = undefined
          this.ready = undefined
        }
        const detail = this.stderr.filter((line) => line.trim()).slice(-3).join("\n")
        const error = new EngineError(detail ? `${why}: ${detail}` : why)
        this.fail(error)
        reject(error)
      }
      child.on("error", (error) => gone(`cannot run ${this.command}: ${error.message}`))
      child.on("exit", (code, signal) => gone(`jj-graph exited (${signal ?? `code ${code}`})`))
    })
    exited.catch(() => undefined)
    const init = (async () => {
      const result = (await this.send("initialize", {
        protocolVersion: PROTOCOL,
        capabilities: {},
        clientInfo: { name: "opencode-jj-graph", version: "1" },
      })) as { instructions?: string }
      this.notify("notifications/initialized")
      return { instructions: result.instructions ?? "" }
    })()
    return Promise.race([init, exited])
  }

  private send(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const child = this.child
    if (!child) return Promise.reject(new EngineError("jj-graph is not running"))
    const id = this.next++
    return new Promise((resolve, reject) => {
      // The process answers in order and cannot stop mid-request, so an abort
      // only stops waiting; the plan still reflects the request.
      const abort = () => {
        this.pending.delete(id)
        reject(new EngineError("cancelled"))
      }
      signal?.addEventListener("abort", abort, { once: true })
      this.pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener("abort", abort)
          resolve(value)
        },
        reject: (error) => {
          signal?.removeEventListener("abort", abort)
          reject(error)
        },
      })
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
    })
  }

  private notify(method: string) {
    this.child?.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n")
  }

  private receive(line: string) {
    if (!line.trim()) return
    let message: { id?: number; result?: unknown; error?: { message?: string } }
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (typeof message.id !== "number") return
    const waiter = this.pending.get(message.id)
    if (!waiter) return
    this.pending.delete(message.id)
    if (message.error) waiter.reject(new EngineError(message.error.message ?? "jj-graph error"))
    else waiter.resolve(message.result)
  }

  private fail(error: Error) {
    const waiting = [...this.pending.values()]
    this.pending.clear()
    for (const waiter of waiting) waiter.reject(error)
  }
}
