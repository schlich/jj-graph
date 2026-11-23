# Show HN: jjr – Guardrails, dry-run patterns, and System-One decisions on top of Jujutsu (jj)

Git trained an entire generation of engineers (and now coding agents) to treat version control as an append-only tape of chronological accidents. Even after adopting Jujutsu (`jj`)—which gives us stable Change IDs, anonymous branches, first-class algebraic conflicts, and an undoable operation log—most humans and agents still use `jj` like Git with shorter flags. They stack unrelated features linearly, accidentally push local integration merges, mix structural refactors with behavioral changes, and burn frontier-LLM calls just to classify a diff.

We built **jjr**, an opinionated framework library and visual workspace on top of `jj` (integrated directly with `jj-graph`'s dry-run engine) that turns Jujutsu's raw graph primitives into self-evident patterns, pre-flight guardrails, and calibrated active feedback.

### Why a framework layer on top of `jj`?

1. **Identity–State Separation at the Type & Runtime Boundary**
   In jjr, a stable 16-byte reverse-hex `ChangeId` (`k–z`) and an ephemeral 20-byte hex `CommitId` (`0–9a–f`) are distinct branded types. Passing a `CommitId` where a `ChangeId` is expected fails immediately with a specific diagnostic instead of silently breaking after the next rebase.

2. **Real Dry-Run Guardrails Before Anything Touches History**
   Every graph rewrite previews through `jj --at-op <tip> --no-integrate-operation`—so `jj` executes the real operation, conflicts and auto-rebases included, without touching the operation log, working copy, or Git refs until you apply. Before even a dry-run executes, jjr works out which revisions the command really rewrites (`jj new -B X` rewrites `X`, `jj new X` only reads it) and runs a composable guardrail pipeline:
   - **Pre-flight Guard**: verifies `trunk()` and `immutable_heads()` resolve before anything mutates the graph.
   - **Immutable Bedrock Guard**: refuses rewrites targeting `immutable()` or `::trunk()`, and never accepts `--ignore-immutable`.
   - **Divergence Guard**: halts stacking (even `jj new`), bookmarking, and pushing when `divergent()` is non-empty, while still allowing `jj converge` and `jj abandon`.
   - **Megamerge Fence**: lets you freely compose parallel feature arms in local octopus merges (`local: dev megamerge`) and route fixes with `jj absorb`, while hard-blocking any push or bookmark whose ancestry includes a megamerge.
   - **Publishing Gate**: before a bookmark or a push, verifies every revision in the range is conflict-free, non-empty, formatted (`jj fix`), and green (`jj run --ignore-changes`), so only the green bottom layers of a stack get published.
   - **Colocated Single-Writer Guard**: jj is the only writer in `.jj/.git` repos; git passes only for read-only inspection.
   - **Workspace Discipline Guard**: keeps branch switching anonymous and reserves `jj workspace add` for parallel builds and parallel agents.
   - **Change-ID Addressing Guard**: warns when mutable work is named by its rotating commit id.

3. **TypeSafe's Jev Decision Model (System One) + a Light LLM Layer (System Two)**
   Most VCS tooling that adds AI reaches straight for a slow chat LLM to parse JSON out of prose. jjr splits the job cleanly:
   - **System One ([TypeSafe Jev](https://typesafe.ai), `POST /v1/systemone`)** runs fast, non-autoregressive, calibrated-probability decisions (`choice`, `score`, `noul`) in parallel against a single diff state—both visibly and behind the scenes:
     - Single-pass change triage (`intent`, structural/behavioral entanglement, publish readiness score, stray debug/secret detection, and new APIs that nothing calls or tests).
     - The **Two-Part Dependency Gate**: evaluates *Causal Necessity* and *Independent Reviewability* as two parallel `noul` questions. High confidence emits `jj parallelize` or `jj squash`; probabilities in the ambiguous band (`0.28–0.72`) pause and ask the human instead of hallucinating certainty.
     - Behind-the-scenes blast-radius scoring, unmarked scratchpad gating, surgical `evolog` vs. repo-wide `op restore` routing, and ambiguous hunk routing for `jj absorb`.
   - **System Two (Light LLM Narrator)** is only invoked when prose is actually needed—writing conventional change descriptions, bookmark slugs, and calm two-sentence diagnostic summaries—with a deterministic offline fallback when no key is set.

4. **Portable TUI & GUI ViewModels + Self-Evident SDLC Patterns**
   Core components (`DagGraph`, `GuardrailBanner`, `DependencyGate`, `TriageCard`, `TimeTravelScrubber`) compute render-agnostic ViewModels (`jjr/ui/core.mjs`) that render 1:1 to ANSI terminals (`jjr/ui/tui.mjs`) or web/desktop GUIs (`jjr/ui/gui.mjs`) using state-not-branch visual tokens. Built-in recipes emit dry-runnable step sequences for *Tidy First?* (structural below behavioral), characterization tests, TDD Red-Test `split --parallel`, Branch by Abstraction, expand & contract, isolated activation switches, local megamerges with `jj absorb`, clean conflict resolution, stack validation, and post-merge convergence. The graph reports which canonical shape it is in (single change, shallow stack, parallel arms, megamerge, resting) with that shape's publishing rule.

5. **Validated with Deterministic + Agentic Evals**
   jjr ships with a 15-scenario eval specification and a runnable harness (`npm run eval`) that spins up throwaway `jj` repos, injects topology and guardrail faults, and checks divergence counts, megamerge leaks, dry-run rewrites, layered publishing, and Jev probability calibration.

Git made rebasing scary. Jujutsu made rebasing fearless. jjr makes clean graph discipline—and calibrated machine assistance—the path of least resistance.

Curious how others are structuring stacked vs. parallel work in `jj`, and where you've seen coding agents tie their commit graphs in knots.
