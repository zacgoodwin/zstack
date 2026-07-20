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

GraphQL budget note (issue #73): lib/board.ts's Q_PROJECT_ITEMS query (used by both list() and snapshot() via the shared listNodes() pagination, ticket #57) requests every ticket's issue body on every call, including the callers that ignore it (z-status, the loop's per-status lists, quota checks). Checked against GitHub's documented rate-limit formula (for each connection, count one request per ancestor-connection combination -- a top-level connection with no ancestors counts as 1 request, never its own first/last arg -- sum those counts across all connections, then divide by 100 and round to the nearest whole number; <https://docs.github.com/en/graphql/overview/rate-limits-and-node-limits-for-the-graphql-api>; GitHub's own worked example scores repos(first:100)->issues(first:50)->labels(first:60) as (1 + 100 + 5,000) / 100 = 51): `body` is a plain scalar String field on Issue, not a connection, so it contributes ZERO points either way. The query's score is driven entirely by its two connections -- items(first: 100), top-level with no ancestors (1 request), and the nested fieldValues(first: 20) per item, whose only ancestor is items(100) (100 requests, one per item, never multiplied by fieldValues' own first arg) -- which work out to (1 + 100) / 100 = 1.01, rounded to 1 point per full page, identical with or without `body`. The real cost of the shared field is response payload size only: up to 65,536 characters (GitHub's issue body cap) per ticket, times up to 100 tickets/page in the worst case -- bandwidth and JSON-parse time, never the rate-limit quota the #61 threshold guard and #58 tick throttling actually protect. Decision: accept the cost -- at ~1 point/page the real cost is even lower than first estimated, reinforcing it. Splitting into a body-free list query would add a second GraphQL constant, a with/without-body parameter threaded through the shared pagination, and a doubled fixture/test surface, to buy zero points against the budget those controls guard.

