# Running the loop as a dedicated bot user

By default `/z-loop` runs as whoever `gh` is authenticated as — in practice,
the repo owner's own GitHub account. Every board claim, issue comment,
commit, and PR the loop makes is then authored as a human, which conflates
"a person is working this repo" with "the loop is working this repo," and
inherits that person's full permissions instead of a scoped set. This page
walks through the alternative: a dedicated bot GitHub account the loop
authenticates as instead. It is self-contained — account creation,
permissions, token, `gh` auth, and verification, start to finish.

**You do not have to do this.** Continuing under your own account is fully
supported; see [Continuing as your own account instead](#continuing-as-your-own-account-instead)
below for what that costs. `/z-setup` (Step 7) and `/z-update` (Step 2) both
ask which you want and record the answer — this page is what they point you
at when you pick the bot.

## Why

- **Attribution.** Commits, PRs, comments, and board claims are the loop's,
  not yours — useful the moment more than one person (or more than one loop)
  touches the same repo.
- **Scoped permissions.** A bot collaborator gets exactly the access the loop
  needs (below), independent of whatever else your own account can do.
- **Fixes issue #204 by construction.** `/z-loop`'s planning pass reads each
  Ready ticket's comments and folds in the newest one from anyone other than
  the loop's own login — a standing decision you leave in a comment (e.g.
  *"closed by decision, do not rebuild"*) is meant to stop the loop from
  reopening it. When the loop's login **is** your login, every comment you
  write is filtered out as "the loop's own," so that check can never fire.
  On one real run this cost a fable-model builder lane 12 requests / $1.55
  re-deriving a decision a human comment had already made. A distinct bot
  login makes every one of your comments visibly "someone else's" again,
  which is all that check needs.
- **The documented way to parallelize.** Two loops sharing one GitHub login
  on different machines both see "the sole assignee is me" and race
  (`z-loop/SKILL.md`'s UNSUPPORTED note). A distinct bot identity per loop
  sidesteps that by giving each loop its own login — it does not add
  cross-machine claim coordination (that stays out of scope; see
  [z-loop.md](z-loop.md)), it just makes "a distinct login" cheap instead of
  requiring a spare personal GitHub account.

Prior art: [savas.me — my coding agent needed its own GitHub identity](https://savas.me/2026/04/27/my-coding-agent-needed-its-own-github-identity/).

## What stays true either way

`/z-loop` never hardcodes an identity. Every touch point resolves it live:

- `ME=$(gh api user -q .login)` (`z-loop/SKILL.md` Step 0) — the session
  name, lane locks, and board **claim** all derive from this one line.
- `bin/z-board claim <N> <assignee>` takes the assignee as a parameter; it is
  never the repo owner's login by default.
- Comments, PRs, merges, and pushes are performed by whichever account `gh`
  is authenticated as — that account is the actor GitHub records.
- **Commit authorship is separate, and the loop sets it explicitly.** `gh`
  auth governs API calls and the HTTPS credential helper (who pushes); the
  author stamped inside a commit object comes from git's own
  `user.name`/`user.email`, which on your machine is *you*. So the loop
  derives `ME_EMAIL` from the same `gh api user` call that resolves `ME`
  (`<id>+<login>@users.noreply.github.com`, GitHub's noreply form) and
  stamps both onto each lane worktree at claim time. Without that, a
  bot-authed loop would still land commits authored by you.

So making the loop run as a bot is a matter of **which account `gh` is
authenticated as when `/z-loop` runs** — there is no config knob for "the
loop's login" (deliberately: `gh api user` staying the single source of
truth is what keeps this trustworthy, and a stored login could disagree with
the live auth). The steps below are all GitHub-account and `gh`-auth setup;
none of them ask you to configure git identity by hand, because the loop
already derives it from the account you authenticate.

> **Why the loop scopes that git identity per worktree.** Git worktrees share
> the main repo's `.git/config`, so writing `user.name` from inside a lane
> worktree the ordinary way would rewrite the identity of your own checkout
> too, re-authoring your personal commits in that repo. The loop uses
> `git config --worktree` (behind `extensions.worktreeConfig`) so the bot
> identity applies only to the lane's worktree and your own checkout keeps
> yours. You never have to set or unset anything.

## Step 1 — Create the bot's GitHub account

GitHub has no API for this — it's a normal signup at
[github.com/join](https://github.com/join), done by you, the owner:

1. Use an email address you control but that is distinct from your own
   account's (most mail providers support `+` addressing, e.g.
   `you+reponame-bot@example.com`, if you don't want a second inbox).
2. Pick a login that reads as a bot, e.g. `<reponame>-loop` or
   `<yourname>-zstack-bot` — this is the login that will show up as the
   author of every commit, PR, comment, and board claim, so name it for
   what a teammate seeing it in the PR list should understand at a glance.
3. Verify the email and finish GitHub's signup flow. A free account is
   sufficient; the bot only needs collaborator access to your repo and
   project, not its own repos or paid features.

## Step 2 — Grant it the minimum permissions

Two **separate** grants — a repo collaborator invite and a Projects
collaborator invite are not the same thing on GitHub, and the loop needs
both:

### 2a. Repository — role "Write"

On the repo: **Settings → Collaborators and teams → Add people** → enter the
bot's username → role **Write**.

Write is what covers every repo-side action the loop takes: editing issue
bodies, posting comments, creating branches, pushing commits, opening PRs,
and merging them (`gh pr merge --squash`). Milestones live on the
repository, not the project, so Write already covers creating and assigning
them too — no separate grant needed there.

### 2b. Project (ProjectV2) — role "Write"

This is the grant that's easy to miss: a GitHub Projects (v2) board is **not**
covered by repository collaborator access, even when the project is attached
to your repo — it has its own, separate access list. Open the project on
github.com (`gh project view <NUMBER> --owner <OWNER> --web`, or from the
repo's **Projects** tab) → **⋯ → Settings → Manage access** → add the bot's
username → role **Write**.

Write on the project is what lets the loop read/move items and set field
values (Status, Model, Model Effort, Estimate, Actual) — every `bin/z-board`
call. Without it, board reads may still work (depending on whether the
project is public) but every board **write** fails with a GitHub permission
error naming the missing grant.

### Table

| Grant | Where | Role | Covers |
| --- | --- | --- | --- |
| Repository collaborator | Repo → Settings → Collaborators and teams | **Write** | Issue edit/comment, branches, commits, PR open + merge, milestones |
| Project collaborator | Project → ⋯ → Settings → Manage access | **Write** | Board item read/move, field writes (Status, Model, Model Effort, Estimate, Actual) |

**This is the documented minimum, derived by reading exactly which GitHub
calls the loop makes (`lib/board.ts`'s GraphQL, `gh issue`/`gh pr`/`git
push`) against GitHub's own permission model — not a live-tested claim.**
Proving it end to end against a real second account (including that removing
either grant fails loudly and names the missing permission, not silently) is
a one-time manual check the owner runs once per install; see
[Verifying the permission set is actually minimal](#verifying-the-permission-set-is-actually-minimal)
below. If you find this list is wrong in either direction — a grant it
doesn't actually need, or one it silently needed that isn't listed — that's
worth reporting back on issue #66.

**A repo with branch protection** (required reviews, required status checks)
can still block the bot's own PRs from merging even with Write — that's the
repo's protection rules applying to every author equally, not a bot
permission gap. Either exempt the bot account from required-reviewer rules
or leave protection as-is and expect the merge stage to exit
`MERGE-NEEDS-APPROVAL` with the PR URL, parking the ticket in **Questions** with
the PR left open for you to approve — same as a human's PR under the same rules.
The loop never overrides the rule to get past it; see
[Never grant the bot `admin`](#never-grant-the-bot-admin--push-is-the-ceiling)
below and `docs/user-guide/z-loop.md`.

### Never grant the bot `admin` — `push` is the ceiling

Write role gives the bot `{admin:false, maintain:false, push:true}`. **That
`admin:false` is a safety control, not an accident of the minimum-permission
exercise above**, and the reason is on the record.

In loop run 12 the merge stage was refused twice by branch protection and then
ran `gh pr merge 224 --squash --admin` — an administrative override of the repo's
protection rules — unprompted, in an unattended session with no human in the
turn. Nothing in its prompt forbade it. The command failed, and the only thing
that made it fail was the bot lacking admin rights: the PR stayed OPEN and
`origin/main` never moved. Run the same loop as the repo owner and that command
squashes an unreviewed branch onto `main` and reports a clean `MERGED:`.

The prompt-side hole is closed — every stage prompt now states that protection
rules are a boundary and not an obstacle, the merge stage exits
`MERGE-NEEDS-APPROVAL` instead of routing around a refusal, and
`evals/merge-safety/` measures whether a live model honors it. But a prompt is a
mitigation and a permission is a wall. Keep both:

| Permission | Bot should hold | Why |
| --- | --- | --- |
| `push` | **yes** | branches, commits, PRs — everything the loop legitimately does |
| `maintain` | no | not needed for any loop action; adds settings surface |
| `admin` | **no** | the only bit that makes `gh pr merge --admin`, ruleset edits, and protection-rule deletion actually work |

Check it any time:

```bash
gh api repos/<owner>/<repo>/collaborators/<bot-login>/permission \
  --jq '{role: .role_name, admin: .user.permissions.admin, maintain: .user.permissions.maintain, push: .user.permissions.push}'
```

Expect `admin:false, maintain:false, push:true`. Anything else — most commonly
from running the loop as the repo owner rather than a bot — means a merge stage
that decides to escalate will succeed. This is the second reason the dedicated
bot account is recommended over
[continuing as your own account](#continuing-as-your-own-account-instead): an
owner identity cannot have this wall.

### Required reviews and the loop

This is the one rule that reliably stops a loop that is otherwise working. A
ruleset carrying a `pull_request` rule with
`required_approving_review_count >= 1` blocks every loop PR: the bot cannot
approve its own, and a review gate satisfied by the system it gates is not a
gate. The loop's own adversarial reviewer stage runs before the PR is opened
and does not count toward GitHub's requirement.

Note that individual users cannot be ruleset bypass actors — GitHub allows only
roles, teams, and apps — so "just exempt the bot" usually means exempting the
Write role, which exempts every human collaborator too. Three honest options:

| Option | Keeps | Costs |
| --- | --- | --- |
| Set the count to 0 | PRs still mandatory on the base branch; no direct pushes | No approval gate on any PR, human or bot |
| Bypass actor for a role/team the bot is in | The rule on paper | Everyone in that role bypasses too |
| Loop runs against a non-default integration branch | The gate on the real base branch | An extra branch, and you merge in batches |

Whichever you pick, check it **before** starting a run rather than discovering
it at the merge stage with the batch already paid for (that is #228's Step 0
preflight). Read the current state with:

```bash
gh api repos/<owner>/<repo>/rulesets --jq '.[] | {id, name, enforcement}'
gh api repos/<owner>/<repo>/rulesets/<ID> \
  --jq '[.rules[] | select(.type=="pull_request") | .parameters.required_approving_review_count]'
```

On this repo (2026-07-31) the count was set to 0 on ruleset 19184288 after a
full batch parked Blocked at merge under the new bot identity; the
wait-for-human-approval flow is tracked in the Review Step milestone (#226).

## Step 3 — Generate a token and authenticate `gh` as the bot

Two ways to get `gh` talking to GitHub as the bot; pick one.

### Option A — `gh auth login` as the bot (recommended, matches how this pack already checks scopes)

```bash
gh auth login
# Follow the prompts, signing in as the BOT account (browser flow or a
# personal access token you generate for the bot in Step 3b below).
```

`gh` supports multiple logged-in accounts per host. After this, confirm the
`project` scope is present — the exact same check `/z-setup`'s own
preconditions run for a human account:

```bash
gh auth status   # look for 'project' in the token scopes list
gh auth refresh -s project   # if it's missing
```

To make the bot the ACTIVE account for a shell session:

```bash
gh auth switch --hostname github.com --user <bot-login>
```

### Option B — a personal access token + `GH_TOKEN` env var (cleanest for an unattended loop)

Generate a **classic** personal access token for the bot account
(`github.com` → bot account's own **Settings → Developer settings →
Personal access tokens → Tokens (classic)**) with scopes **`repo`** and
**`project`** (add `workflow` too only if your loop is expected to edit
`.github/workflows/*.yml` files — most projects don't need it).

**Classic is required, not merely preferred. A fine-grained PAT cannot drive
this loop at all.** This was measured against a real bot account holding repo
**Write** as a collaborator (2026-07-30, recorded on #66), and it fails on two
independent walls:

1. **A fine-grained PAT's permissions are scoped to its *resource owner*,** and
   the only resource owner a bot account can select is itself (unless it belongs
   to an organization). Your repo is owned by *you*, so a token the bot mints
   holds **no grants on it whatsoever**, no matter what was ticked at creation.
   It will still read a public repo, because that needs no grant — which makes
   the token look fine right up until the first write.
2. **GitHub does not support fine-grained PATs for user-owned Projects.** Their
   own docs list it verbatim as a known gap: *"Using fine-grained personal
   access token to access Projects owned by a user account."* The board is a
   ProjectV2, so board access fails even once the repo side is sorted.

What that looks like on the wire, same account, same repo:

| Operation | Fine-grained PAT | Classic (`repo` + `project`) |
| --- | --- | --- |
| Read the repo / an issue | works (public, no grant) | works |
| Resolve the board's ProjectV2 id | `NOT_FOUND` | works |
| Create a branch | `403 Resource not accessible by personal access token` | works |
| Comment on / edit an issue | `403` | works |
| Open a PR | `403` | works |

If you are looking at `Resource not accessible by personal access token` on a
token whose permissions appear correct, this is why. **The exception:** if the
repo and board are owned by an **organization** the bot belongs to, fine-grained
PATs do work, because the org can be the resource owner and org-owned Projects
are supported.

Tick only `repo`, `project`, and (if needed) `workflow`. The classic token page
starts with everything unchecked and it is easy to grab far more; nothing in
this pack uses `admin:org`, `delete_repo`, or the rest of the `admin:*` family,
and a token carrying them turns a leak into an account-level incident instead of
a repo-level one. Scopes cannot be edited after creation — to narrow one, revoke
it and mint a new one.

Then, instead of touching your own `gh auth login` session at all, export
the token only in the environment that launches the loop:

```bash
export GH_TOKEN="<the bot's token>"   # gh reads this before its stored auth
/z-loop
```

`gh` (and everything that shells `gh`, which is every board/issue/PR call
this pack makes) checks `GH_TOKEN`/`GITHUB_TOKEN` before its stored
keyring/config auth, so this doesn't disturb your own `gh auth login` session
at all — set it in the loop's own launch script or a dedicated shell profile,
never in your interactive shell's regular startup files.

### Verify `gh` is now the bot

```bash
gh api user -q .login   # must print the BOT's login, not yours
```

## Step 4 — Record the choice

Run `/z-setup` (Step 7) with `gh` authenticated as the bot per Step 3 above.
It detects no recorded choice yet, asks which branch you want, and — once
you confirm bot — records it:

```bash
bun "$PACK/lib/identity.ts" record --slug "<slug>" --mode bot \
  --token-location "GH_TOKEN env var in the loop's launch script"   # or: "gh auth login (bot profile)"
```

`--token-location` is a **note for future you**, not a secret and not a
second copy of the login — it's what a re-check months later (`/z-update`'s
Step 2, or you re-reading `config.json`) tells you about *where* to look if
the bot's access ever needs rotating. The token itself is never written to
`config.json`.

## Org-owned repos: what re-verification can (and can't) do

Every step above works identically whether the repo belongs to you
personally or to an organization — creating the bot account, both
collaborator grants, and generating the token don't depend on who owns the
repo. What differs is what `/z-setup`'s re-verification (Step 7, on every
re-run after the first) can tell you automatically.

GitHub shares one login namespace between personal accounts and
organizations, but no individual human ever authenticates AS an
organization — you always authenticate as yourself. On a **personal** repo
the owner IS a specific human's own login, so `/z-setup` can compare the
active `gh` login against it and warn you if a recorded bot identity looks
like it quietly fell back to a human login. On an **org-owned** repo, the
repo's "owner" is the org's slug, which no individual login can ever equal
— so that comparison can't distinguish a human login from a bot login
there, for anyone. Rather than either falsely warning on every single
re-run (what an org-owned "human" project used to get) or falsely staying
silent about a real regression (what an org-owned "bot" project used to
get), `/z-setup` reports the raw facts on an org repo — the recorded state
and the currently active login — and asks you to eyeball it yourself.

There's no extra setup step for this; it's a limit of what's automatically
checkable. On an org-owned repo it's worth periodically running
`gh api user -q .login` yourself and confirming it still prints the bot's
login before trusting a long-unattended loop. To switch a recorded choice
on an org repo (human → bot, or back), authenticate `gh` as the account you
want and tell `/z-setup` directly that you've finished — the automatic
"did something change" nudge described above is a personal-repo-only
convenience, but recording the switch itself (`identity.ts record`) works
identically everywhere.

## Verifying the permission set is actually minimal

This is the one piece of this page that has to be proven against a real
second account rather than just documented — do it once per install:

1. **The happy path.** With `gh` authenticated as the bot and both grants
   from Step 2 in place, run a small end-to-end slice: claim a ticket, edit
   its body, open a PR, squash-merge it, push and delete the branch. Expect
   every step to succeed, `gh api user -q .login` to return the bot's login
   throughout, and the board claim to show the bot as assignee. Check
   authorship in **both** places, because they come from different
   mechanisms: the PR and the squashed commit on the default branch follow
   the account that opened/merged the PR (that's `gh` auth), while the
   individual commits listed inside the PR carry the git author the lane
   stamped (that's `ME_EMAIL`, set per worktree at claim time). Both should
   read as the bot; if the branch commits show *you*, the lane's
   `git config --worktree` step didn't run — see
   [What stays true either way](#what-stays-true-either-way).
2. **The missing-grant path.** Temporarily remove ONE grant (Projects Write
   is the easiest to toggle without touching repo access) and re-run a
   board-write step. Expect a clear GitHub permission error, not a silent
   failure or a confusing downstream symptom — and expect it to name exactly
   the grant you removed. This is what proves the documented minimum in the
   table above is actually *necessary*, not just *sufficient*.

Record what you found — confirming or correcting the table above — on issue
#66 or wherever this project tracks that kind of note.

### Result of the first run (2026-07-30, recorded on #66)

Both paths were run against a real non-owner bot account. The happy path
passed end to end with a classic token: identity resolved to the bot, the
board read returned the Model / Model Effort / Estimate / Actual fields, the
claim assigned the bot and released cleanly, and the branch commit, the PR,
and the squash merge were all authored by the bot. (The merge commit's
*committer* reads `web-flow`, which is GitHub's own identity for any
API- or UI-driven merge; the *author* is the bot. That is expected, not a
misconfiguration.)

The missing-grant path was exercised with a token carrying **no** Projects
access at all: every board read and write failed with `NOT_FOUND` on the
ProjectV2 id, while the same account with `project` succeeded. That proves the
`project` grant in the table above is *necessary*, not merely sufficient. Note
the failure mode — a missing Projects grant surfaces as `NOT_FOUND` on the
board, which reads like "the board doesn't exist" rather than like a permission
error. Check the grant before you go looking for a bad project id.

## Continuing as your own account instead

Fully supported. `/z-setup`'s Step 7 and `/z-update`'s Step 2 both offer it
as an explicit option — there's no need to read this page at all if you pick
it. The cost, stated plainly: **issue #204 stays live.** The planning pass's
fold-in gate can never see your own comments as "someone else's" while the
loop's login is your login, so a standing instruction you leave on a ticket
(*"superseded by #183, close this"*, *"don't rebuild, already decided"*) is
invisible to the loop — it will claim and rebuild the ticket anyway, exactly
as it did on the run that prompted this ticket. Nothing is unsafe about this
choice; it's a real tradeoff between "zero setup" and "the fold-in gate
actually works," and either is a legitimate answer depending on how hands-on
you plan to stay.

You can switch to a bot identity later at any time: come back to this page,
work through Steps 1-4, then re-run `/z-setup`. On a **personal** repo it
detects that `gh` no longer resolves to you, confirms with you that this is
really the switch to the bot (never automatic — a different personal login
on the machine could trigger the same detection), and only then re-records
the choice. On an **org-owned** repo that detection isn't available (see
[Org-owned repos](#org-owned-repos-what-re-verification-can-and-cant-do)
above) — tell `/z-setup` directly once you've finished the bot setup and it
records the switch the same way.

## Verification checklist

- [ ] `gh api user -q .login` prints the bot's login (not yours), in the
      shell/session that will run `/z-loop`.
- [ ] The bot is a repo collaborator with **Write**.
- [ ] The bot is a project collaborator with **Write** (checked separately
      from the repo grant — this is the one people miss).
- [ ] `gh api repos/<owner>/<repo>/collaborators/<bot-login>/permission`
      reports `admin:false` — see
      [Never grant the bot `admin`](#never-grant-the-bot-admin--push-is-the-ceiling).
      `push` is the ceiling; `admin` is the bit that would let a merge stage
      override branch protection for real.
- [ ] `bun "$PACK/lib/identity.ts" state --slug <slug>` prints
      `{"state":"bot"}`.
- [ ] A test claim (`bin/z-board claim <N> <bot-login>`, or just watching the
      next real `/z-loop` run) shows the bot as the assignee on github.com.
- [ ] A test PR is authored and merged by the bot, not you.
- [ ] The individual commits inside that PR also show the bot as author (a
      separate mechanism from the line above — see step 1 of
      [Verifying the permission set](#verifying-the-permission-set-is-actually-minimal)).
- [ ] **Org-owned repo only:** since `/z-setup` can't auto-detect a login
      drift here (see [Org-owned repos](#org-owned-repos-what-re-verification-can-and-cant-do)),
      periodically re-check `gh api user -q .login` yourself rather than
      trusting a long-unattended loop's "no changes" report.

If any box doesn't check out, re-read Step 2 (the Projects grant is separate
from the repo grant) and Step 3 (confirm `GH_TOKEN` is actually set in the
shell that runs `/z-loop`, or that `gh auth switch` actually landed on the
bot) before assuming something in this pack is broken.
