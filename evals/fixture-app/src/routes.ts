// The fixture app's routing table, kept pure so it is unit-testable without a
// listening socket. `route()` maps a path + query to a status + JSON body;
// `handle()` is the thin Bun.serve adapter over it. The e2e eval's fixture-spec
// asks the loop to grow this file (a structured-response helper, then a richer
// /health, then a /metrics route) as a three-ticket dependency chain.

export interface RouteResponse {
  status: number;
  body: unknown;
}

export const ROUTES = ["/", "/health", "/echo"] as const;

// Pure dispatch: same path + params always yields the same status + body, so the
// gate tests need no network. Unknown paths are a 404 with a clear message, not
// a thrown error -- an error path that swallows nothing.
export function route(pathname: string, params: URLSearchParams): RouteResponse {
  switch (pathname) {
    case "/":
      return { status: 200, body: { name: "fixture-app", routes: ROUTES } };
    case "/health":
      return { status: 200, body: { status: "ok" } };
    case "/echo": {
      const msg = params.get("msg");
      if (msg === null || msg === "") {
        return { status: 400, body: { error: "missing required 'msg' query param" } };
      }
      return { status: 200, body: { echo: msg } };
    }
    default:
      return { status: 404, body: { error: `no route for ${pathname}` } };
  }
}

// The adapter Bun.serve calls. Kept trivial on purpose: all behavior lives in
// route(), which the tests exercise directly.
export function handle(req: Request): Response {
  const url = new URL(req.url);
  const r = route(url.pathname, url.searchParams);
  return Response.json(r.body, { status: r.status });
}
