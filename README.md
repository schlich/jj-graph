<img src="assets/icon.svg" width="64" height="64" alt="">

# jj-graph

A touch-first web UI for [Jujutsu](https://jj-vcs.dev) built around the
revision graph. Drag changes, edges and bookmarks around the DAG to try
operations as a dry run, then commit to the result with one button.

<img src="assets/screenshot.png" width="320" alt="A dry run on a phone: two rewritten changes above the immutable trunk"> <img src="assets/history.png" width="320" alt="Looking back at an earlier operation">

## It draws jj's model, not Git's

- **Changes are cards, and the change id leads.** A change you can still
  rewrite is a card with a grip. When a dry run rewrites one, the card stays
  put under the same id and shows only the commit underneath changing
  (`a3d2→55e5`). **Evolution** lists every version a change has had, and
  **Restore this version** previews putting one change back without
  rewinding anything else.
- **Colour means state, never branch.** jj has no current branch, so nothing
  is coloured by lane. The working copy, empty changes, conflicts and
  previewed rewrites each have their own look.
- **The working copy is a change.** `@` is a card like the others, with a
  live file count. There is no staging area to show.
- **Immutable history is bedrock.** Commits you cannot rewrite collapse to
  one quiet line each on a thick spine; everything above it is yours to move.
- **Bookmarks are tags hung on changes.** They do not follow you around, and
  you drag them like any other object.
- **Conflicts do not block.** A conflicted change is a hatched card that you
  can keep moving, and the plan says how many there are without stopping you.
- **Descendants follow on their own.** Changes that jj rebased because
  something beneath them moved are marked `auto-rebased`, apart from the ones
  you touched.
- **The operation log is a timeline.** The strip under the title bar is every
  state the repository has been in. Tap a dot to look at the graph as it was,
  and **Restore to here** to preview going back. A dry run's steps continue
  the same line past "now", because they are operations that have not
  happened yet.

## Run it

jj-graph is a Rust program built on jj's own libraries. Build it with Rust
1.97 or newer; at run time it needs `jj` 0.47.1 on `PATH`, the release its
libraries come from. With [devenv](https://devenv.sh), `devenv shell` brings
Rust, jj, git and Node and adds `serve [REPO]`, `mcp [REPO]` and `jjr-eval`;
`devenv up` serves this repository on port 7777, and `devenv test` runs every
test, the eval scenarios included.

```sh
cargo install --path crates/jj-graph
jj-graph [REPO] [--port 7777] [--host 127.0.0.1] [--verify-command CMD]
```

The web UI and these docs are compiled into the binary.

With Nix, `nix run github:schlich/jj-graph -- [REPO]` (or
`nix run . -- [REPO]` in a checkout) builds it with a matching `jj`.
`nix develop` opens a shell with Rust, jj, git and Node, and
`nix flake check` runs every test, including the eval scenarios.

To use it from a phone, bind an address the phone can reach, such as
`--host 0.0.0.0`. The printed URL then carries a token, and the API refuses
requests without it. Anyone holding that URL can rewrite the repository, so
keep it to a network you trust.

`--verify-command` is the build-and-test command that **Verify stack** runs in
each revision (for example `--verify-command 'npm test'`). Without it,
jj-graph reads `jj config get jjr.verify-command`, so a repository can carry
its own: `jj config set --repo jjr.verify-command 'npm test'`. The command
only ever comes from your configuration, never from a request.

## Gestures

| Do this | To get |
| --- | --- |
| Drag a card's grip (or its dot) onto another change | A menu: move with descendants, move alone, move the branch, insert after or before, squash into, add as a parent, duplicate |
| Drag a grip onto an edge | Insert the change between the edge's two ends |
| Drag an edge onto a change | Reparent: the edge's child swaps that parent for the drop target |
| Drag a bookmark onto a change | Move the bookmark |
| Tap a change | Its actions: new child, edit, describe, move, squash, duplicate, bookmark, diff, evolution, abandon |
| Tap an edge | Insert a new change there, or remove that parent from a merge |
| Tap a bookmark | Move or delete it |
| Tap a dot on the timeline | Look at that operation, or jump to that step of the dry run |
| Drag a card or empty space, pinch, or scroll | Pan and zoom |

Every menu entry shows the exact `jj` command it stands for. **Move…** on a
change is the same as dragging, done with taps: pick the change, then tap its
destination. The `jj ▸` button dry-runs any command you type.

With a keyboard, the status line at the bottom shows the current mode
(`NORMAL`, `PICK`, `DRAG`, `HISTORY` or `INPUT`) and the keys that work in
it. `[` and `]` step through the timeline.

## How the dry run works

Nothing you do in the graph touches the repository until you press **Apply**.

Each step runs as `jj --at-op <previous step> --no-integrate-operation <command>`.
jj performs the command for real, conflicts included, and writes an operation
that it leaves out of the operation log. Before it runs, the jjr guardrails
check the step, with the revisions it rewrites resolved by jj-lib at that point
of the plan; a blocked step explains why and what to do instead, and a
warning (an unverified bookmark, say) appears as a notice. The graph then shows the repository
as of that operation. The working copy, the Git refs of a colocated
repository, and `jj log` in your terminal all stay as they were.

- **Undo** and **redo** step back and forth through the plan.
- **Discard** forgets the plan. Its operations are left unreferenced for
  `jj util gc` to collect.
- **Apply** runs `jj op integrate` on the last step and then
  `jj workspace update-stale`, and offers to undo the whole apply with
  `jj op restore`.

If the repository changes while a plan is open, for example because you
edited a file, the plan is replayed on top of the new state, so applying it
never leaves divergent changes. If a step no longer applies, the plan is
marked out of date and Apply is disabled until you undo that step or discard.

jj-graph reads the repository in-process with jj-lib, at any operation,
including the ones a plan leaves out of the operation log. It loads your
configuration the way `jj` does (user, repository and workspace layers,
conditional scopes, revset aliases), so `trunk()` and `immutable_heads()` mean
exactly what they mean to `jj`. Everything it writes (snapshots, dry-run
steps, `op integrate`, `op restore`, `jj fix`, `jj run`) goes through the `jj`
command itself, so command semantics, working-copy updates and Git
import/export are exactly jj's.

## Limits

- Commands with effects outside the repository (`git push`, `git fetch`) and
  interactive ones (`squash -i`, `resolve`, `split` without paths) cannot be
  dry-run and are refused. `split` with paths, `fix`, and `converge` (always
  with `--no-interactive`) can.
- `--ignore-immutable` is refused: a dry run never force-rewrites
  `immutable()` history.
- The graph draws at most 400 revisions of the revset, and the timeline the
  newest 14 operations.
- A typed command that names a change created earlier in the same plan by a
  shortened id may fail to replay after the repository changes. Commands
  built by dragging use full ids and do not have this problem.

## Use it from an agent

### OpenCode

The OpenCode 2 plugin in `.opencode/plugins/jj-graph` gives the agent the
tools below and shows you what it is doing with them. In every directory
inside a jj repository it runs one `jj-graph mcp` process, registers its
tools as native OpenCode tools (`jj-graph_dry_run`, ...), and publishes the
graph that process sees, jjr's reading of it and the agent's dry-run plan
to OpenCode's front ends:

- **TUI**: a *jj graph* section in the session sidebar (the working copy,
  the stack, the plan, jjr's verdict) and an item in the home footer.
  `ctrl+x j` (`<leader>j`) or `/jj-graph` opens the jj graph panel beside
  the session: the graph with `jj log`'s lanes, the plan step by step with
  each step's output, jjr's diagnostics with their fixes, and the operation
  log. Its bottom line names the mode (`NORMAL`, `DETAIL`, or `PROMPT`
  while it is unfocused) and every key that works in it: `j`/`k` move,
  `h`/`l` or `1`–`4` switch section, `⏎` shows details, `y` copies the
  change id, step, fix or operation, `r` re-reads, `f` goes full screen,
  `esc` goes back or closes.
- **Desktop app**: the same views in a *jj graph* tab of the session's side
  region (`mod+shift+j`, `/jj-graph`, or the region's **+** menu), with the
  same keys and the same mode line.

The views follow the repository live: after every jj-graph tool call, after
any other tool (an edit, a shell), and whenever jj records an operation,
the jj you run in a terminal included.

Both front ends run the same two [XState](https://stately.ai/docs/xstate)
statecharts (XState 6, a beta). `source.machine.ts` reads a directory through
the RPC: one read at a time, a change during a read means one more read after
it, and jj-graph saying it cannot read the repository drops the read in
flight. `view.machine.ts` holds the panel's focus, mode, section and
selection; each mode state declares its name and keys in `meta`, so the mode
line and the hint line list exactly the keys the machine would take, and the
selection follows a change rather than a row position. Paste either file into
[Stately](https://stately.ai) to see and simulate its statechart. Outside a jj repository the plugin
does nothing, so it is safe to install for every project. OpenCode loads it
by itself in this checkout. Others reach the same state through the
`jj-graph` RPC (`rpc.ts`): a `state` method and a `changed` event.

Elsewhere, install it globally by linking the directory into
`~/.config/opencode/plugins/jj-graph`, or list it in `opencode.json`. The
desktop app loads a plugin's desktop part only from the global
`~/.config/opencode/opencode.json`. The flake's `opencode-plugin` package
is the plugin with the desktop part built and this flake's `jj-graph` baked
in, so it needs nothing on PATH:

```sh
nix build github:schlich/jj-graph#opencode-plugin -o ~/.config/opencode/plugins/jj-graph
```

Used from a checkout instead, install the plugin's one runtime dependency
with `npm ci` in `.opencode/plugins/jj-graph/` (only XState belongs there:
OpenCode supplies Solid and its own SDK), build the desktop part with
`npm ci && npm run build` in `opencode-gui/`, and note that the plugin runs
`jj-graph` from PATH. Make sure that is this program (another project ships
a `jj-graph` without an `mcp` command), or name the binary with the
`command` option:

```json
{
  "plugins": [
    {
      "package": "/absolute/path/to/jj-graph/.opencode/plugins/jj-graph",
      "options": { "command": "/absolute/path/to/jj-graph", "verifyCommand": "cargo test" }
    }
  ]
}
```

| Option | Default | Does |
| --- | --- | --- |
| `command` | `jj-graph` (the Nix package: its own store path) | The jj-graph executable |
| `verifyCommand` | none | Passed as `--verify-command`, which `verify_stack` runs in each revision |
| `codemode` | OpenCode's default (`true`) | Expose the tools through Code Mode |

The tools ask the same permissions as an MCP server's would
(`jj-graph_dry_run`, ...), so existing permission rules still apply. When
your configuration already has an `mcp.servers.jj-graph` entry, that server
keeps the tools; the views then show the repository but not the agent's
plan, which lives in that server's process.

### Other MCP clients

`jj-graph mcp` serves the same engine to an AI agent over the
[Model Context Protocol](https://modelcontextprotocol.io), on stdin and
stdout. The agent previews jj commands with `dry_run`, reads the graph each
step leaves, and makes the plan real with `apply_plan`, which returns the
operation `restore_operation` takes to undo it. The agent's plan is its own:
a web UI open on the same repository keeps a separate one.

```sh
jj-graph mcp [REPO] [--verify-command CMD]
```

`REPO` defaults to the directory the client starts the server in. To add it
to Claude Code for every repository:

```sh
claude mcp add --scope user jj-graph -- jj-graph mcp
```

or for one project, in its `.mcp.json`:

```json
{ "mcpServers": { "jj-graph": { "command": "jj-graph", "args": ["mcp"] } } }
```

| Tool | Does |
| --- | --- |
| `graph` | One line per revision (change id, commit id, title, bookmarks, state, parents), then the jjr diagnostics |
| `dry_run` | Adds one jj command to the plan once the guardrails pass it |
| `plan_undo`, `plan_redo`, `plan_discard` | Step through the plan, or drop it |
| `apply_plan`, `restore_operation` | Make the plan real, and undo that |
| `op_log`, `show`, `evolog` | The operation log, a revision's files or diff, a change's earlier versions |
| `diagnose`, `preflight`, `guard` | The jjr reading of the graph, the pre-flight facts, and a guardrail check for pushes, Git commands, bookmarks and workspaces |
| `verify_stack`, `publish_plan` | Run the verify command in each revision, then see which layers can be published |
| `triage`, `assess_dependency`, `suggest_name` | Jev change triage, the stack-or-parallelize gate, and a title with a bookmark slug |
| `recipe` | A jjr pattern's steps, each with the arguments to pass to `dry_run` |

The graph shows 12-character change ids, and `dry_run` expands them to full
ids, so the agent's plans replay cleanly after the repository changes
underneath them.

## jjr framework

`jj-graph` ships with **jjr** (the `jjr` crate in `crates/jjr`), a framework
layer integrated directly with the dry-run engine. It reasons over the graph
jj-graph reads, so it does not depend on jj-lib itself:

- **Identity–state types (`jjr::types`)**: validated separation between
  `ChangeId` (reverse-hex `k–z`), `CommitId` (hex `0–9a–f`), `OpId`, and
  `BookmarkName`.
- **Command model (`jjr::commands`)**: which revisions each jj command
  rewrites, only reads, or points a bookmark at (`jj new X` reads `X`,
  `jj new -B X` rewrites it, `jj squash` rewrites `@` and `@-`), so guardrails
  check what a command really does.
- **Guardrail pipeline (`jjr::guardrails`)**: eight rules that gate every
  dry-run step, bookmark, push, Git command, and workspace creation:
  Pre-flight (`trunk()` and `immutable_heads()` must resolve), Immutable
  Bedrock (never `immutable()` or `::trunk()`, never `--ignore-immutable`),
  Divergence Guard, Megamerge Fence, Publishing Gate (conflict-free,
  non-empty, formatted, green; bookmarks included), Colocated Single-Writer
  (git is read-only), Workspace Discipline, and Change-ID Addressing.
- **Graph model and diagnostics (`jjr::graph`)**: the canonical DAG shape
  of your work (single change, shallow stack, parallel arms, megamerge, resting)
  with its publishing rule, and diagnostics with dry-runnable fixes for
  structural-above-behavioral order, activation switches that are not on top or
  not tiny, edited megamerges, redundant merge parents, interior merges,
  overlapping parallel arms, uneven arm bases, undescribed changes, absorbable
  fixups, clean conflict resolution, behavior without tests, arms based on an
  old trunk, deep stacks, divergence, and Git features jj does not support
  (submodules, LFS, `.gitattributes`, hooks).
- **Verification and publishing (`jj-graph`, `jjr::runner`)**: **Verify
  stack** runs `jj fix` and the verify command (`jj run --ignore-changes`) in
  every mutable revision as operations it never keeps; the Publishing Gate
  reads those results, and **Plan publishing** marks which bottom layers of a
  stack can be published now for the configured forge (`jjr.forge`: Gerrit,
  GitHub bookmarks, jj-stack, jj-spr).
- **TypeSafe Jev System-One decisions (`jjr::jev`)**: wire-compatible
  `POST /v1/systemone` client (`choice`, `score`, `noul`) with calibrated
  offline fallback. Powers single-pass change triage, the Two-Part Dependency
  Gate (pausing for human confirmation in the ambiguous probability band),
  scratchpad/blast-radius risk advisories, dual time-axis recovery routing, and
  ambiguous `jj absorb` hunk routing. Set `TYPESAFE_API_KEY` to enable live
  Jev inference.
- **Light LLM narrator (`jjr::narrator`)**: System-Two prose layer strictly
  for naming changes, bookmark slugs, and two-sentence diagnostic summaries
  (set `JJR_LLM_API_KEY` or `OPENAI_API_KEY`, with deterministic fallback).
- **SDLC patterns & portable UI (`jjr::patterns`, `jjr::ui`)**: dry-run
  recipes (squash and edit workflows, *Tidy First?*, characterization tests,
  TDD red-test verification, Branch by Abstraction, expand & contract,
  isolated activation, local megamerges and `jj absorb`, shared-primitive
  extraction, clean conflict resolution, stack validation, agent workspaces,
  post-merge convergence), the six-phase SDLC lifecycle, and render-agnostic
  ViewModels that port 1:1 to TUI (`jjr::ui::tui`) or GUI
  (`jjr::ui::gui`).

Open `/docs` while `jj-graph` is running (or open `docs/index.html` directly)
for the interactive reference documentation.

## jj-shape

`crates/jj-shape` keeps a stack's change graph a mirror of the code's
dependency graph: `jj-shape check` reports what is out of place, and
`plan` and `normalize` compute the unique normal form of `trunk()..@` and
rebase to it as one verified jj operation. Its behaviour is specified in
Quint and tested with Hegel properties. It has its own lockfile and Nix
build, and runs on Linux; `nix run .#jj-shape` runs it, and
[its README](crates/jj-shape/README.md) covers the model, the commands,
and the limits.

## Develop

```sh
cargo test --workspace                # jjr, the engine, and the 15 eval scenarios
cargo test -p jj-graph --test evals   # just the eval scenarios (evals/scenarios.json)
node --test                           # the web UI's layout tests
(cd .opencode/plugins/jj-graph && bun test)  # the OpenCode plugin's model and statecharts
```

The engine tests and eval scenarios build throwaway repositories with `jj`
(and `git` for the convergence scenario's remote) and cover the dry-run plan,
replay, apply, undo, history, evolution, the command model, pre-flight, jjr
guardrails, verification, layered publishing, TypeSafe Jev workflows, and
portable UI ViewModels.

Dependencies build unoptimized and without debug info: optimized, a single
`rustc` process for jj-lib or jj-cli took over 4 GiB. On a machine with little
memory, cap parallel jobs too: `CARGO_BUILD_JOBS=2 cargo test --workspace`.

