---
name: z-setup
description: |
  One-time per-project setup for the zstack dev loop. Creates or adopts a GitHub
  ProjectV2 board with the canonical nine statuses and four custom fields
  (Model, Model Effort, Estimate, Actual), turns off the workflow rules that
  fight the loop, records the epic style, and writes ~/.zstack/projects/<slug>/
  config.json so z-board / z-estimate / z-cost work. Idempotent: re-running
  adopts what already exists and changes nothing.
  Use when asked to "set up zstack", "z-setup", "create the board", or before the
  first planning pass on a repo that has no ~/.zstack config yet.
---

# /z-setup — Board + fields + workflow rules for one repo

You are setting up the zstack dev loop for a single GitHub repo. This is the one
skill that WRITES `~/.zstack/projects/<slug>/config.json`; every other z-tool
only reads it. Follow the steps in order. The deterministic half (project, field,
and status creation + verification) is `bin/z-setup-board`; you drive the
decisions and the one manual step GitHub's API can't do.

Resolve the pack directory once (the skill and bins are installed together):

```bash
PACK="$HOME/.claude/skills/zstack"
[ -d "$PACK" ] || PACK="$(cd "$(dirname "${BASH_SOURCE:-$0}")/.." && pwd -P)"
Z_SETUP="$PACK/bin/z-setup-board"
```

Decide the identifiers up front:

```bash
OWNER=$(gh repo view --json owner -q .owner.login)
REPO=$(gh repo view --json name -q .name)
SLUG="$REPO"          # ~/.zstack/projects/<slug>/; one board per repo
TITLE="$REPO"         # ProjectV2 title; adoption matches on this
```

---

## Step 1 — Preconditions (stop on any failure)

Run each check. Do not continue past a failure; fix it and re-run.

1. **gstack installed.** `[ -d "$HOME/.claude/skills/gstack" ]`. If missing, stop and tell the user:
   `git clone --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack && cd ~/.claude/skills/gstack && ./setup --team`
2. **bun present.** `command -v bun` — if missing, stop: install from https://bun.sh.
3. **gh authenticated.** `gh auth status` — if it fails, stop: `gh auth login`.
4. **Token has the `project` scope.** This is the failure this session actually hit
   live: GraphQL returns `missing required scopes [read:project]`. Check and fix:

   ```bash
   if ! gh auth status 2>&1 | grep -q "'project'"; then
     echo "Token is missing the 'project' scope. Refreshing..."
     gh auth refresh -s project
   fi
   # Re-check after the refresh; a scoped probe is the real proof.
   gh api graphql -f query='query { viewer { login } }' >/dev/null \
     && echo "gh scopes OK" \
     || { echo "Still cannot query GraphQL; resolve gh auth before continuing." >&2; exit 1; }
   ```

   Always print the exact `gh auth refresh -s project` command and re-check after
   running it. Do not proceed until the scoped probe passes.

---

## Step 2 — Epic style (D1)

Ask the user how epics should be modeled, using AskUserQuestion in the
decision-brief format. This is written to `epicStyle` in config.json.

```
D1 — How should epics be modeled on this board?
Project/branch/task: First-time zstack setup for <OWNER>/<REPO>.
ELI10: An "epic" is a big piece of work that breaks into many small tickets. We
  can group those tickets two ways. Option A: a GitHub "milestone" per epic — a
  built-in bucket you drop issues into, with a progress bar. Option B: a special
  "epic" issue that lists its children as sub-issues. Both work; they change how
  you'll file and track the children later.
Stakes if we pick wrong: switching later means re-tagging every existing ticket,
  so pick the one that matches how you already think about the work.
Recommendation: A (milestones-as-epics) because it's the original zstack
  preference, needs no issue-type config, and the milestone progress bar is a
  free burn-down.
Completeness: A=9/10, B=8/10
Pros / cons:
A) Milestones as epics (recommended)
  ✅ Built-in progress bar and filter (`milestone:"zstack-v1"`) with zero setup
  ✅ z-board create already targets a milestone, so no new plumbing is needed
  ❌ A ticket belongs to exactly one milestone, so an epic can't overlap another
B) Epic issue with sub-issue relations
  ✅ Nested hierarchy shows parent/child directly in the issue UI
  ✅ A child can be linked under more than one parent if scopes overlap
  ❌ Needs the sub-issues feature and more manual linking per ticket
Net: milestones are the lower-effort default that matches existing tooling;
  sub-issues buy hierarchy you probably don't need yet.
```

Record the answer as `milestones` (A) or `issue-type` (B) — call it `$EPIC_STYLE`.

---

## Step 3 — Plan, then create or adopt the board

Preview exactly what will change (zero writes):

```bash
"$Z_SETUP" plan --owner "$OWNER" --repo "$REPO" --title "$TITLE"
```

- Empty plan → the board already matches; skip to Step 5 (verify) and Step 6.
- Non-empty plan → apply it. `apply` creates the project if it doesn't exist,
  otherwise adopts the one whose title matches `$TITLE`, drives the Status field
  to the canonical nine statuses (Backlog, Ready, Questions, Building, QA,
  Review, Blocked, Skipped, Done), and creates the four custom fields
  (Model: haiku/sonnet/opus/fable; Model Effort: low/medium/high/xhigh;
  Estimate: number; Actual: number). It also writes config.json.

```bash
"$Z_SETUP" apply --owner "$OWNER" --repo "$REPO" --slug "$SLUG" --title "$TITLE" \
  --epic-style "$EPIC_STYLE" --max-lanes 3 --watchdog-minutes 10
```

To adopt a specific existing project instead of matching by title, add
`--project-number <N>`. `apply` is idempotent: re-running plans and executes zero
mutations once the board is correct.

---

## Step 4 — Workflow rules (manual, GitHub's API can't toggle these)

GitHub ProjectV2 built-in workflows are NOT exposed by the GraphQL API — there is
no mutation to read or flip them. Two of them fight the loop and must be turned
off by hand:

- **"Item closed" / any "close the issue when Status = Done"** — the loop leaves
  Done tickets OPEN for a human to review and close (PROCESS.md). Auto-closing
  removes them from the loop's view prematurely.
- **"Auto-archive items"** — archived items drop out of `z-board list`, so the
  loop stops seeing them.

Print these exact steps and require the user to confirm before finishing:

1. Open the project: `gh project view <NUMBER> --owner <OWNER> --web`
   (the number is printed by `apply`; or `gh project list --owner "$OWNER"`).
2. Click **⋯ → Workflows**.
3. Disable **Auto-archive items** (toggle off).
4. Disable any workflow that **closes an issue** when an item is closed or moved
   to Done. Leave "Item added → set Status" style workflows alone.

Then confirm via AskUserQuestion (D2): "Auto-archive and issue-auto-close are both
turned off in the project's Workflows?" Options: **A) Yes, both are off
(recommended)** / **B) Not yet — hold**. Do not report DONE until the user
answers A. If B, stop and wait.

---

## Step 5 — Verify (scripted, not eyeballs)

Confirm the live board matches the contract. Non-zero exit means drift:

```bash
"$Z_SETUP" verify --owner "$OWNER" --repo "$REPO" --title "$TITLE"
```

This prints one line per item (Status + the four fields) as `OK` or `DRIFT` and
exits non-zero on any drift. If it drifts, re-run Step 3's `apply` (idempotent)
and verify again. Do not proceed until verify exits 0.

Sanity-check the written config too — it must load and validate:

```bash
bun "$PACK/lib/board.ts" quota --slug "$SLUG" >/dev/null && echo "config loads"
```

(`loadConfig` runs the full schema validation on read; a malformed config fails
loudly here, naming the bad field.)

---

## Step 6 — Wire up deploy

Invoke gstack `/setup-deploy` (via the Skill tool) so `/land-and-deploy` works at
the end of the loop. Follow its prompts for this repo.

---

## Done criteria

Report DONE only when all of these hold:

- Step 1 scoped GraphQL probe passed (project scope present).
- `verify` exited 0: nine statuses + four fields with the right option sets.
- The user confirmed auto-archive and issue-auto-close are OFF (Step 4, D2 = A).
- `~/.zstack/projects/<slug>/config.json` exists and loads (Step 5).
- `/setup-deploy` ran.

A re-run of /z-setup on an already-set-up repo must make zero changes (idempotent).
