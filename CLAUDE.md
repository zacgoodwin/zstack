## gstack (recommended)

This project uses [gstack](https://github.com/garrytan/gstack) for AI-assisted workflows.
Install it for the best experience:

```bash
git clone --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack
cd ~/.claude/skills/gstack && ./setup --team
```

Skills like /qa, /ship, /review, /investigate, and /browse become available after install.
Use /browse for all web browsing. Use ~/.claude/skills/gstack/... for gstack file paths.

## Deploy Configuration (configured by /setup-deploy)

- Platform: none (skill pack — installed to ~/.claude/skills/zstack, not hosted)
- Production URL: none
- Deploy workflow: merge PR to main; users install/update the pack from main
- Deploy status command: none
- Merge method: squash
- Project type: CLI / skill pack
- Post-deploy health check: `bun test && bun run typecheck` on main

### Custom deploy hooks

- Pre-merge: `bun test && bun run typecheck`
- Deploy trigger: merge to main (no push-triggered deploy)
- Deploy status: none
- Health check: `bun test && bun run typecheck`

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec
