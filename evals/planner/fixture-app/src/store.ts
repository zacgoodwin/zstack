// shortcli storage layer -- the ONLY file that exists in the fixture app today.
// It holds short-code -> URL mappings in memory. The eval spec (../fixture-spec.md)
// asks the planner to (1) make this persist to disk, (2) build a shortener
// service on top of it, and (3) expose a CLI. A grounded plan cites this file and
// these line numbers.

export interface Mapping {
  code: string; // short code, e.g. "a3f9"
  url: string; // the full destination URL
}

// In-memory store. Not persisted: process exit loses every mapping. Making this
// durable is the first ticket in the chain the spec implies.
export class Store {
  private map = new Map<string, string>();

  put(code: string, url: string): void {
    this.map.set(code, url);
  }

  get(code: string): string | undefined {
    return this.map.get(code);
  }

  has(code: string): boolean {
    return this.map.has(code);
  }

  all(): Mapping[] {
    return [...this.map.entries()].map(([code, url]) => ({ code, url }));
  }
}
