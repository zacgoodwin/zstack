# Spec: shortcli — a tiny link shortener

`shortcli` is a command-line link shortener for a single user. Today the repo has
only an in-memory storage layer (`src/store.ts`). We want it usable end to end
from the terminal, persisting across runs.

## What we want

A user can shorten a URL and get back a short code, then resolve that code back
to the original URL later — even after quitting and reopening the tool. Codes
must survive a restart.

### Behaviors

1. **Durable storage.** Mappings persist to a JSON file on disk (`~/.shortcli/
   store.json`) and reload on startup, so a code created yesterday still resolves
   today. Today `src/store.ts` keeps everything in memory and loses it on exit.

2. **Shorten + resolve.** Given a URL, produce a stable, collision-free short
   code and remember it. Given a code, return the URL (or a clear "unknown code"
   result). This logic sits above storage; it decides the code, storage just
   holds it.

3. **CLI surface.** `shortcli shorten <url>` prints the new code; `shortcli
   resolve <code>` prints the URL or an error; `shortcli list` prints all
   mappings. The CLI parses arguments and calls the shorten/resolve logic.

## Constraints

- Bun + TypeScript, matching the existing `src/store.ts` style.
- No network calls and no third-party dependencies for the core (ponytail: reuse
  the stdlib and the existing `Store` class).
- Each behavior ships with its own gate tests.

## Notes for the planner

The three behaviors build on each other: persistence is the foundation, the
shorten/resolve service uses it, and the CLI uses the service. Plan them in the
order they can actually be built, and record which waits on which. Ground every
plan in the real `src/store.ts` (cite the class and line refs you rely on).
