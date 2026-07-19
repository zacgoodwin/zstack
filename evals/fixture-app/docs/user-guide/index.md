# fixture-app user guide

This is the docs stub the e2e eval's `/document-release` step updates on a green
loop. It exists so the fixture has a real `docs/user-guide/` tree for the loop to
touch, matching the pack's own docs layout.

## Routes

| Route | Response |
|-------|----------|
| `GET /` | `{ "name": "fixture-app", "routes": [...] }` |
| `GET /health` | `{ "status": "ok" }` |
| `GET /echo?msg=<text>` | `{ "echo": "<text>" }`, or `400` if `msg` is missing |

## Running it

```bash
bun install
bun run src/server.ts   # serves on http://localhost:8787 (override with PORT)
bun test                # the gate suite
bun run typecheck       # tsc --noEmit
bun run build           # bundles src/server.ts into dist/
bun run deploy          # stubbed: echoes and exits 0
```
