// Baseline gate tests for the fixture app. They pass on a clean checkout so the
// e2e eval starts from a green suite; the loop's tickets add more alongside
// these. Pure and fast -- route() needs no socket, handle() builds a Response
// in-process.
import { test, expect, describe } from "bun:test";
import { route, handle, ROUTES } from "../src/routes.ts";

const q = (s = "") => new URLSearchParams(s);

describe("route()", () => {
  test("/ lists the routes", () => {
    const r = route("/", q());
    expect(r.status).toBe(200);
    expect((r.body as { routes: readonly string[] }).routes).toEqual([...ROUTES]);
  });

  test("/health is ok", () => {
    expect(route("/health", q())).toEqual({ status: 200, body: { status: "ok" } });
  });

  test("/echo returns the message", () => {
    expect(route("/echo", q("msg=hi"))).toEqual({ status: 200, body: { echo: "hi" } });
  });

  test("/echo without msg is a 400", () => {
    expect(route("/echo", q()).status).toBe(400);
  });

  test("unknown path is a 404", () => {
    expect(route("/nope", q()).status).toBe(404);
  });
});

describe("handle()", () => {
  test("wraps route() as a JSON Response", async () => {
    const res = handle(new Request("http://x/echo?msg=yo"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ echo: "yo" });
  });
});
