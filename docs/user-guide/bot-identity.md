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
- Commits and PRs are authored by whatever `gh`/`git` are configured to use
  at push/PR-create time.

So making the loop run as a bot is entirely a matter of **which account `gh`
is authenticated as when `/z-loop` runs** — no code changes, no config knob
for "the loop's login" (deliberately: `gh api user` staying the single
source of truth is what keeps this trustworthy). The steps below are all
GitHub-account and `gh`-auth setup; none of them touch this repo's code.

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
or leave protection as-is and expect the merge stage to report a blocked PR,
same as it would for a human's PR under the same rules.

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
`.github/workflows/*.yml` files — most projects don't need it). Classic
scopes are what this pack's own scope probe (`gh auth status` /
`gh auth refresh -s project`) understands; a fine-grained PAT's "Projects"
account permission covers the same access but doesn't show up as a `project`
OAuth scope, so it hasn't been exercised against this pack's preflight
check — prefer classic unless you've verified otherwise.

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

## Verifying the permission set is actually minimal

This is the one piece of this page that has to be proven against a real
second account rather than just documented — do it once per install:

1. **The happy path.** With `gh` authenticated as the bot and both grants
   from Step 2 in place, run a small end-to-end slice: claim a ticket, edit
   its body, open a PR, squash-merge it, push and delete the branch. Expect
   every step to succeed, `gh api user -q .login` to return the bot's login
   throughout, the board claim to show the bot as assignee, and the merge
   commit + PR to be authored by the bot.
2. **The missing-grant path.** Temporarily remove ONE grant (Projects Write
   is the easiest to toggle without touching repo access) and re-run a
   board-write step. Expect a clear GitHub permission error, not a silent
   failure or a confusing downstream symptom — and expect it to name exactly
   the grant you removed. This is what proves the documented minimum in the
   table above is actually *necessary*, not just *sufficient*.

Record what you found — confirming or correcting the table above — on issue
#66 or wherever this project tracks that kind of note.

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
work through Steps 1-4, then re-run `/z-setup` — it detects that `gh` no
longer resolves to you, confirms with you that this is really the switch to
the bot (never automatic — a different personal login on the machine could
trigger the same detection), and only then re-records the choice.

## Verification checklist

- [ ] `gh api user -q .login` prints the bot's login (not yours), in the
      shell/session that will run `/z-loop`.
- [ ] The bot is a repo collaborator with **Write**.
- [ ] The bot is a project collaborator with **Write** (checked separately
      from the repo grant — this is the one people miss).
- [ ] `bun "$PACK/lib/identity.ts" state --slug <slug>` prints
      `{"state":"bot"}`.
- [ ] A test claim (`bin/z-board claim <N> <bot-login>`, or just watching the
      next real `/z-loop` run) shows the bot as the assignee on github.com.
- [ ] A test PR is authored and merged by the bot, not you.

If any box doesn't check out, re-read Step 2 (the Projects grant is separate
from the repo grant) and Step 3 (confirm `GH_TOKEN` is actually set in the
shell that runs `/z-loop`, or that `gh auth switch` actually landed on the
bot) before assuming something in this pack is broken.
