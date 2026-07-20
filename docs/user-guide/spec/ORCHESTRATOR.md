The interactive Claude session that invokes the loop run is an orchestrator, NOT a worker. Its only jobs are:

Verify preconditions (clean git, no orphan workers, GraphQL quota, etc.).
Dispatch per the config's worker_backend:
"workflow" (default) — stay in-session and run the wave loop in skills/super-board/references/run-workflow.md: plan a wave, claim assignees, launch the super-board-wave dynamic workflow, reconcile, repeat. Lane agents inside the workflow do all product work.
"claude-p" (legacy, explicit opt-in only) — spawn the headless runner nohup scripts/super-board-run.sh <slug> &, report PID + log path, exit. The runner refuses to start (exit 78) unless the config sets this value.
Report back to the user (dispatch confirmation, or one status line per wave).
The orchestrator MUST NOT:

Build, test, review, or fix issues itself. All product work is delegated to claude -p workers.
Patch the dispatcher script or skill files mid-run, even if it sees a problem. Capture the symptom and tell the user; wait for explicit approval.
Wait for workers. They write their evidence back to the GitHub issue + PR. The orchestrator's user-facing output is the dispatch confirmation, not the run result.
Hold context for multi-card progress. State lives on the GitHub Project board + the inflight lockfiles, not in the orchestrator's session.
Inline a stage's payload into its own context. Each stage spawn (builder/QA/reviewer/merge) is driven by a POINTER prompt: the orchestrator assembles the large fields (ticket body, diff, acceptance criteria) off-context into `input-<N>.json` (via `jq --rawfile` from files, never inlined in a command whose text it reads back), and the printed prompt only references that file's absolute path, telling the worker to read the payload from it. So the prompt the orchestrator reads back to spawn the Agent is small and payload-independent — the body/diff reaches the worker without transiting the orchestrator's context. The per-iteration drain tick is likewise a single `bin/z-loop-tick` call (snapshot → ingest → next) that prints only the one-line next Action, so a long drain's repeated bookkeeping never accumulates in-session.
If a problem surfaces during the run, the orchestrator's reply is: "I saw X. Want me to dig in or stop the runner?" — not "I went ahead and fixed it."

Worker rules

Workers share the dispatcher's gh token bucket. They MUST:

Prefer local git blame / git log over gh api graphql for any sub-agent that doesn't need fresh state.
Cap adversarial sub-agents at 50 gh calls each. If a sub-agent runs out, it returns confidence: insufficient_data rather than burning the shared quota.
Append gh-quota-on-exit: graphql=<n>/5000 rest=<n>/5000 to the PR handoff comment.

