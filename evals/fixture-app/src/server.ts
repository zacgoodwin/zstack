// Entry point: serve the routing table on a port. `build` bundles this file;
// `bun run src/server.ts` runs it. The routing logic lives in routes.ts so the
// server itself stays a one-liner over Bun's native HTTP server (no framework --
// ponytail: the platform already ships one).
import { handle } from "./routes.ts";

const port = Number(process.env.PORT ?? 8787);

Bun.serve({ port, fetch: handle });

console.log(`fixture-app listening on http://localhost:${port}`);
