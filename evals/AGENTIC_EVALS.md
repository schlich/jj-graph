# Validating jjr with Agentic Evals

## 1. Why Unit Tests Are Not Enough

Unit tests prove that `megamergeFence()` returns `{ allowed: false }` on a mock graph. They do **not** prove whether an autonomous coding agent—or a human assisted by jjr's guardrails, TypeSafe Jev System-One decisions, and light LLM narrator—reliably converges to a clean, bisectable, non-divergent DAG under real repository chaos: mid-flight rebases, algebraic conflicts, accidental linear chains, colocated `.git` interference, and entangled diffs.

jjr is validated with a **4-Tier Agentic Eval Harness** executed inside ephemeral colocated (`jj git init --colocate`) repositories using real `jj` and `git` binaries.

---

## 2. Harness Architecture

1. **Seeded Fixture Generator (`evals/harness.mjs`)**
   Spins up throwaway colocated repositories with deterministic `trunk()`, mutable feature stacks, simulated remotes, and controlled fault injections (divergent commits, conflicted trees, unmarked megamerges, structural-above-behavioral stacks, and entangled diffs).
2. **Paired Control vs. Treatment Runner**
   Executes each scenario under two conditions with identical turn budgets (15 turns):
   - **Control (raw `jj` + `git`)**: Agent operates directly via shell commands without jjr.
   - **Treatment (jjr)**: Agent operates through `JjrRunner` (backed by `jj --at-op ... --no-integrate-operation` dry-runs), `JjrGuardrailPipeline`, `JjrPatterns`, `JjrJevAssistant`, and `JjrNarrator`.
3. **Deterministic Graph & Bisect Grader (60% weight)**
   Evaluates final repository invariants directly via `jj log`, `jj op log`, `jj evolog`, and `jj bisect run`:
   - `divergent()` count equals `0`
   - `conflict()` count in any publishable range equals `0`
   - `immutable()` SHAs are byte-identical before and after
   - Every publishable revision builds and passes tests independently (`jj run` / per-commit verification)
   - Zero local megamerges bookmarked or pushed
   - Post-merge resting state converges cleanly onto `trunk()`
4. **Jev Calibration & Cost Grader (25% weight)**
   Measures TypeSafe Jev System-One decisions (`choice`, `score`, `noul`) against ground-truth labels:
   - **Expected Calibration Error (ECE) <= 0.08** and **Brier score <= 0.14** on Two-Part Dependency `noul` probabilities
   - **Abstention accuracy**: ambiguous diffs land in the `[0.28, 0.72]` confirmation band rather than triggering silent wrong rewrites
   - **System-One / System-Two split**: >= 85% of classification/gating calls resolved by Jev (`POST /v1/systemone`) without invoking the light LLM narrator
5. **Topological & Naming Judge (15% weight)**
   Reviews final DAG topology and descriptions for Two-Part Dependency discipline, *Tidy First?* ordering (structural beneath behavioral), isolated activation switches, and clear conventional commit titles.

---

## 3. Eval Suites (12 Scenarios in `evals/scenarios.json`)

| Suite | Scenarios | Primary Invariant Tested |
| :--- | :--- | :--- |
| **A. Topology & Dependency** | `topo-01` Accidental linear chain<br>`topo-02` Mutually entangled split | Two-Part Dependency Test (`parallelize` vs `collapse` vs `stack`) |
| **B. Hard Guardrails** | `guard-01` Megamerge push attempt<br>`guard-02` Immutable bedrock rewrite<br>`guard-03` Colocated `git checkout` on conflict<br>`guard-04` Divergence halt & recovery | Hard-block before mutating disk; actionable remediation surfaced |
| **C. SDLC & Graph Surgery** | `sdlc-01` *Tidy First?* structural below behavioral<br>`sdlc-02` TDD Red-Test `split --parallel`<br>`sdlc-03` Branch by Abstraction 5-step swap<br>`sdlc-04` `jj absorb` atop octopus megamerge | Every publishable intermediate revision builds and passes tests |
| **D. Dual Time-Axis & Convergence** | `time-01` Surgical `evolog` vs repo-wide `op restore`<br>`conv-01` Post-merge convergence to `trunk()` | Single-change restore preserves sibling arms; clean post-merge loop |

---

## 4. Target Release Gates

| Metric | Raw `jj` Control Baseline | jjr Release Gate |
| :--- | :--- | :--- |
| **Zero-Divergence Completion Rate** | ~75% | **>= 99%** |
| **Megamerge Leak Rate (pushed)** | ~15% | **0%** (hard-blocked) |
| **Per-Commit Bisectability (`jj bisect`)** | ~60% | **>= 95%** |
| **Jev Dependency Calibration (Brier)** | N/A | **<= 0.14** |
| **Mean Recovery Turns After Fault** | 4.5 turns | **<= 1.5 turns** |
| **Unnecessary `workspace add` Rate** | ~25% | **0%** |

---

## 5. Running the Deterministic Eval Harness

Run the local deterministic fixture suite against real `jj` repositories:

```sh
npm run eval
```

Each scenario builds an isolated temporary repository with `jj git init`, injects the fault condition, exercises `JjrRunner`, `JjrGuardrailPipeline`, and `JjrJevAssistant`, and prints a pass/fail scorecard with timings.
