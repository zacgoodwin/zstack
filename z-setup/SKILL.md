---
name: z-setup
description: |
  One-time per-project setup for the zstack dev loop. Creates or adopts a GitHub
  ProjectV2 board with the canonical nine statuses and four custom fields
  (Model, Model Effort, Estimate, Actual), turns off the workflow rules that
  fight the loop, records the epic style, raises the loop's GitHub identity
  choice (a dedicated bot account, recommended, or continuing as the owner's
  own login -- issue #66) and records it, and writes ~/.zstack/projects/<slug>/
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

Epic style is currently fixed to `milestones`: one GitHub milestone per epic —
a built-in bucket you drop issues into, with a free progress bar, and the
grouping `z-board create --milestone` already targets. Do not ask the user;
set it directly:

```bash
EPIC_STYLE=milestones
```

The alternative — an "epic" issue whose children are linked as sub-issues
(`issue-type`) — is **not yet supported**: no sub-issue create path exists in
the loop, so `z-setup-board` rejects `--epic-style issue-type` and config
validation rejects `epicStyle: "issue-type"` until one is implemented
(issue #14). When that lands, this step becomes a real D1 decision again.

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

**Board shape is a template.** The nine statuses and four fields above are not
hardcoded — they are the shipped `z-setup/board-template.json` (status name +
color + description, field name + dataType + options, and the intended views),
loaded and validated before any mutation. To ship a variant (e.g. different
option colors), pass `--template <file>` to `plan` / `apply` / `verify`. The
loader refuses a template whose status set is not the canonical nine, or that
drops or renames any of the four required fields — Model, Model Effort, Estimate,
Actual — the loop hard-depends on, so a bad template fails loudly naming the
field, before the board is touched.

**Board views are manual.** The template also describes board views (a Status
kanban, a milestone cost table), but GitHub's GraphQL API exposes no
view-creation mutation — only a read-only `ProjectV2View` object. So `plan` and
`apply` print each view as an explicit manual step (open the project on
github.com, add the view by hand) rather than silently dropping them. Set these
views up after Step 4.

**Destructive adopt guard.** Replacing the options of any single-select field
(Status, Model, Model Effort) on an adopted board deletes every non-canonical
option (e.g. GitHub's default Todo / In Progress), and items assigned to a
deleted option silently lose that field's value. When such options still have
items, `apply` refuses before running any mutation and lists each field and
option with its item count. Show that list to the user and only re-run with
`--force` after they explicitly confirm the loss; `--force` proceeds and prints
what was dropped, per field.

**Run adopt while the board is quiescent.** The guard re-checks usage
immediately before the replace runs and refuses (even under `--force`) if an
option was populated in the meantime, but the Projects API has no conditional
mutation, so a small window between that recheck and the replace remains: an
item assigned to a deleted option inside it still loses its value silently.
Make sure no other sessions, loops, or humans are moving items on the board
while `apply` adopts it.

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

## Step 7 — GitHub identity: bot account or the human's own (issue #66)

Not optional like Step 8 below — every project must leave this step with an
answer recorded, either branch. Every board claim, comment, commit, and PR
`/z-loop` makes is authored as whoever `gh` is authenticated as when it runs
(`ME=$(gh api user -q .login)`, z-loop/SKILL.md Step 0 — that resolution
needs no code change here or anywhere; `gh api user` stays the single source
of truth). This step only makes the owner's CHOICE of who that should be
durable and re-checkable; see
[the full setup guide](../docs/user-guide/bot-identity.md) for the
account/permissions/token walkthrough.

Check whether this project already answered (re-running /z-setup must never
re-ask — AC7):

```bash
STATE=$(bun "$PACK/lib/identity.ts" state --slug "$SLUG" | jq -r .state)
```

**`$STATE` is `"bot"` or `"human"` already:** do not blindly re-ask — but do
verify the live `gh` login still matches what's recorded (idempotent,
changing nothing when it does — AC7), and flag it when it doesn't. A
rotated/revoked bot token, or someone running `gh auth login` as themselves,
can silently fall back to the owner's own login on a recorded `"bot"`
project; conversely, a recorded `"human"` project whose active login is no
longer the owner usually means the bot-account setup
(docs/user-guide/bot-identity.md) just happened and the active `gh` login
changed.

```bash
CURRENT_LOGIN=$(gh api user -q .login)
if [ "$STATE" = "bot" ] && [ "$CURRENT_LOGIN" = "$OWNER" ]; then
  echo "WARNING: config.json records a bot identity, but the active GitHub CLI login is the repo owner ($OWNER). Re-authenticate as the bot account, or re-run this step to deliberately record 'continue as human' instead."
elif [ "$STATE" = "human" ] && [ "$CURRENT_LOGIN" != "$OWNER" ]; then
  echo "config.json records 'continue as human', but the active GitHub CLI login ('$CURRENT_LOGIN') is not the repo owner ('$OWNER') -- confirm below before switching."
else
  echo "Identity already recorded as '$STATE' (currently authenticated as '$CURRENT_LOGIN'). No changes."
fi
```

The first branch's warning is the full remediation — nothing further to run.
The third branch (`"No changes"`) needs nothing further either — the common,
stable case on every re-run.

The second branch needs a human decision before recording anything, same
discipline as the `"unset"` case below: never auto-switch on a login change
alone, since `$CURRENT_LOGIN` could just as easily be a different personal
account as the bot (e.g. a teammate briefly authenticated on a shared
machine). Ask via AskUserQuestion: "config.json still records this project
as continuing on your own account, but `gh` is now authenticated as
`$CURRENT_LOGIN`, not the owner `$OWNER` — this looks like you finished the
bot-account setup. Switch the recorded identity to bot?" Options:
**A) Yes, record `$CURRENT_LOGIN` as the bot identity** / **B) No, this is a
different personal login — leave it recorded as human.** On A, confirm the
token/gh-auth location the same way as Answer A below, then run the same
`identity.ts record --mode bot` command. On B, leave `config.json` untouched.

**`$STATE` is `"unset"`** (first-time setup, or a project that predates
issue #66): ask the owner via AskUserQuestion, decision-brief format (D3):

```
D3 — Should the loop run as its own bot GitHub account, or continue as yours?
Project/branch/task: First-time (or predates-#66) identity setup for
  <OWNER>/<REPO>.
ELI10: Every board claim, comment, commit, and PR the loop makes is
  attributed to whoever `gh` is logged in as when it runs -- today, you. A
  dedicated bot account (GitHub has no API to create one -- you do this by
  hand, see the linked guide) separates "a human is working the repo" from
  "the loop is working the repo," scopes the loop's permissions
  independently of your own account, and fixes issue #204 by construction:
  the loop's "did a human say something new" check can never see YOUR
  comments as someone else's while you and the loop share a login, so a
  standing instruction you leave in a comment (e.g. "closed by decision, do
  not rebuild") is invisible to the planning pass.
Stakes if we pick wrong: "continue as human" is fully supported and
  reversible later (re-run this step to switch), but #204 stays live on this
  project the whole time -- on loop run 11 that cost a fable-model lane 12
  requests / $1.55 rebuilding a ticket a human comment had already closed by
  decision. "bot" requires real setup work first (account, collaborator add,
  token -- GitHub has no API for any of the three); this step waits for you
  to finish it.
Recommendation: bot account for any project running the loop unattended for
  real; human account only for a quick trial, or a repo where board writes
  always happen with a human at the keyboard anyway.
Completeness: bot=9/10 (10 needs #204's own timestamp-based fix to close the
  gap for every project, not just this one -- tracked separately), human=10/10
  (fully documented tradeoff, so it can't be "wrong")
Pros / cons:
A) Dedicated bot account (recommended) -- see docs/user-guide/bot-identity.md
  ✅ Attributable activity, independently scoped permissions
  ✅ #204's fold-in gate works by construction
  ❌ Real setup work first: account, collaborator add, token -- GitHub has no
     API for any of the three
B) Continue as your own account
  ✅ Zero setup, works today
  ❌ #204 stays live: a standing human instruction left in a comment is
     invisible to the planning pass
Net: no wrong answer, only a tradeoff the owner should make knowingly instead
  of by default -- ask, don't guess.
```

- **Answer A (bot).** Point the owner at
  [docs/user-guide/bot-identity.md](../docs/user-guide/bot-identity.md) to
  create the account, add it as a collaborator with the documented
  permission set, and generate a token. Wait for them to confirm `gh` is
  authenticated as the bot (`gh api user -q .login` prints the bot's login,
  not `$OWNER`), then record it:

  ```bash
  bun "$PACK/lib/identity.ts" record --slug "$SLUG" --mode bot \
    --token-location "<what the owner told you, e.g. 'gh auth login (bot profile)' or 'GH_TOKEN env var in the loop's launch script'>"
  ```

- **Answer B (human).** The D3 brief above already states the #204
  consequence; do not accept without it (AC5). Record it:

  ```bash
  bun "$PACK/lib/identity.ts" record --slug "$SLUG" --mode human
  ```

---

## Step 8 — Auto-approvals (optional, after deploy is wired up)

/z-setup's own job is done once Steps 1-7 pass; this step is a separate,
**optional** offer that does not gate Done criteria below. Offer it every
time anyway — never skip asking because deploy already worked. It exists
because of an incident discovered live on 2026-07-18: running the loop with
default permissions turns the human into a click-through machine, since every
novel agent command re-prompts and stacks a one-off allow rule in
`~/.claude/settings.json` forever.

Ask the user via AskUserQuestion, decision-brief format (D4):

```
D4 — How permissive should Claude Code be on this machine going forward?
Project/branch/task: First-time zstack setup for <OWNER>/<REPO>.
ELI10: Claude Code asks permission before running most commands. In a loop
  that runs unattended, every never-seen-before command re-prompts, and each
  approval only allowlists that one exact command — so the list grows
  forever and you become a click-through machine. There are three levers:
  (1) a hook that answers every permission prompt "allow" automatically,
  (2) a default mode that skips the dialog for future sessions, (3) a short
  list of specific rules (any git/gh/bun/bunx command) that cover the commands
  the loop runs most, with no hook at all — Edit, Write, and everything else
  still prompt.
Stakes if we pick wrong: THIS EDITS ~/.claude/settings.json, which is
  MACHINE-WIDE — every project on this machine inherits whatever you pick
  here, not just this one. Picking A and regretting it means every repo you
  touch ran with zero prompts until you undo it (see Undo below).
Recommendation: A (full auto-approvals) for a machine dedicated to running
  the zstack loop unattended; B if you still want prompts for anything
  outside git/gh/bun/bunx (including every Edit and Write); C if this machine
  is shared or you are not ready to hand over blanket approval yet.
Completeness: A=9/10, B=8/10, C=10/10 (C is "do nothing", so it can't be wrong)
Pros / cons:
A) Full auto-approvals (recommended for solo loop use)
   [PermissionRequest allow hook + defaultMode: bypassPermissions +
   skipDangerousModePermissionPrompt/skipAutoPermissionPrompt: true + the
   allow rules from B — the hook grants everything regardless of that list]
  ✅ Zero prompts, this session and every future one — the loop runs unattended
  ✅ Survives a session restart (defaultMode + skip flags are read at startup)
  ❌ Machine-wide: every other project on this machine also runs unprompted
B) Loop allowlist only
   [just the specific allow rules: Bash(git *), Bash(gh *), Bash(bun *),
   Bash(bunx *) — no hook, no mode change, and deliberately NO Bash(bash *) /
   Bash(claude *) / bare Edit / bare Write blanket]
  ✅ Smallest blast radius: only git/gh/bun/bunx commands run unprompted
  ❌ Everything else — Edit, Write, and any novel command — still prompts, so
     the loop is NOT fully unattended under B
C) Skip
  ✅ No permission changes at all; today's behavior continues untouched
  ❌ Back to a prompt per novel command; one-off rules keep piling up
Net: A trades machine-wide blast radius for zero babysitting; B is the middle
  ground; C changes nothing. There's no wrong answer, only a tradeoff — ask,
  don't guess.
```

Apply the answer with the deterministic half (never hand-edit the file):

```bash
case "$ANSWER" in
  A) "$PACK/bin/z-setup-permissions" full ;;
  B) "$PACK/bin/z-setup-permissions" allowlist ;;
  C) : ;; # no permission changes
esac
```

`z-setup-permissions` merges into `~/.claude/settings.json` (default path; pass
`--path` to target a different file, e.g. in tests) — it never clobbers
existing keys or rules, JSON-validates before and after, and writes atomically
(tmp file + rename) so a crash mid-write can't corrupt the file you already
have. Re-running it once everything is configured makes zero changes and says
so. `"$PACK/bin/z-setup-permissions" --check` reports each of the three layers
(hook / bypassMode / allowlist) independently present or absent, with zero
writes.

**Undo**, if A or B turns out to be wrong: open `~/.claude/settings.json` and
- remove the `hooks.PermissionRequest` array entry whose command contains
  `"permissionDecision":"allow"`,
- restore `permissions.defaultMode` to whatever it was before (or delete the
  key), and remove `skipDangerousModePermissionPrompt` /
  `skipAutoPermissionPrompt`,
- optionally also drop the `Bash(git *)` / `Bash(gh *)` / `Bash(bun *)` /
  `Bash(bunx *)` entries from `permissions.allow` if you want B's changes gone too.
There is no automated undo command — the change is small enough to hand-edit
and re-validate as JSON afterward.

**Implementation note (from a live incident on 2026-07-18):** a running
Claude Code session persists its in-memory permission state back to
`settings.json` on every approval event, and can clobber a concurrent edit if
one lands mid-session. `z-setup-permissions` writes atomically and re-reads
the file to verify its own write survived, failing loudly instead of
reporting success on a write that didn't stick. The hook itself takes effect
through Claude Code's settings watcher — no restart needed. `defaultMode` and
the skip flags are read at session startup only, so a session already running
keeps prompting until it's restarted; if a prompt slips through right after
answering A, that's a straggler session, not a bug — restart it.

---

## Done criteria

Report DONE only when all of these hold:

- Step 1 scoped GraphQL probe passed (project scope present).
- `verify` exited 0: nine statuses + four fields with the right option sets.
- The user confirmed auto-archive and issue-auto-close are OFF (Step 4, D2 = A).
- `~/.zstack/projects/<slug>/config.json` exists and loads (Step 5).
- `/setup-deploy` ran.
- Step 7 (GitHub identity, issue #66) has a recorded choice -- `"bot"` or
  `"human"` -- in `config.json`. First-time setup requires an explicit
  answer (this DOES gate DONE, unlike Step 8 below); a re-run whose active
  `gh` login still matches what's recorded reports it and changes nothing.
  A re-run whose active login has drifted from what's recorded surfaces
  that (Step 7's warning/confirm branches) and, for a recorded-human ->
  now-authenticated-as-someone-else drift, may update the record, but only
  after the owner explicitly confirms the switch.
- Step 8 (auto-approvals) was offered via AskUserQuestion; its answer (A/B/C)
  does not gate DONE.

A re-run of /z-setup on an already-set-up repo whose `gh` login hasn't
changed must make zero changes (idempotent); a re-run after the active `gh`
login was deliberately switched is expected to surface that drift, per
Step 7 above.
