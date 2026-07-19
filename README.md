# zstack

An installable Claude Code skill pack, laid out like gstack: one directory
per skill (`SKILL.md`, `bin/`, `lib/`), a `setup` script, and a `VERSION`
file. Skills land in later milestones; this repo currently ships the pack
scaffold and process docs.

## Install

```bash
git clone <this-repo> ~/.claude/skills/zstack
cd ~/.claude/skills/zstack && ./setup
```

Requires:

- [gstack](https://github.com/garrytan/gstack) installed at `~/.claude/skills/gstack`
- [bun](https://bun.sh)
- [gh](https://cli.github.com) (GitHub CLI)

`./setup --team` also registers zstack with Codex/Factory when those tools
are present, mirroring gstack's `--team` mode.

## Layout

- `references/`: process docs (`PROCESS.md`, `PRINCIPLES.md`,
  `ESTIMATION.md`, `ORCHESTRATOR.md`, sample transcripts, dev-loop diagrams)
- `tests/`: gate tests, run via `bun test`
- `setup`: precondition checks + pack registration
