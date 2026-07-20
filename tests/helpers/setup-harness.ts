// Shared harness for the setup-registration gate tests: throwaway $HOME with a
// stubbed gh, a synthetic pack, and a bash spawn with an EXPLICIT env. The env
// is built from scratch (never `...process.env`) because on Windows the spread
// yields both `Path` and `PATH` keys and which one MSYS bash honors is not
// guaranteed — the stub-bin prefix could silently lose to the real PATH.
// PATH entries are POSIX-form (':'-separated): mixing `C:\` drive-letter paths
// with ':' separators breaks bash's PATH parsing.
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

export const SETUP_SRC = join(import.meta.dir, "..", "..", "setup");

const BASH = Bun.which("bash");
if (!BASH) throw new Error("bash not found on PATH: required to exercise the setup script");

export function toPosixPath(winPath: string): string {
  const m = winPath.match(/^([A-Za-z]):[\\/](.*)$/);
  if (!m) return winPath.replace(/\\/g, "/");
  return `/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`;
}

function binDir(name: string): string {
  const resolved = Bun.which(name);
  if (!resolved) throw new Error(`${name} not found on PATH: required to build test fixtures`);
  return toPosixPath(dirname(resolved));
}

const BUN_DIR = binDir("bun");
const CORE_DIR = binDir("uname"); // /usr/bin on Windows: mkdir, cp, rm, ln, grep, head

export interface SetupEnv {
  root: string;
  home: string;
  skills: string;
  stubBin: string;
}

export function makeEnv(roots: string[], prefix = "zstack-setup-reg-"): SetupEnv {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  const home = join(root, "home");
  const skills = join(home, ".claude", "skills");
  mkdirSync(join(skills, "gstack"), { recursive: true }); // precondition gate
  const stubBin = join(root, "stub-bin");
  mkdirSync(stubBin);
  writeFileSync(join(stubBin, "gh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return { root, home, skills, stubBin };
}

// A minimal pack: the real setup script plus synthetic z-* skills, so tests
// pin the registration contract without copying the whole repo around.
export function makePack(dir: string, skillNames: string[]) {
  mkdirSync(dir, { recursive: true });
  copyFileSync(SETUP_SRC, join(dir, "setup"));
  for (const name of skillNames) {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(
      join(dir, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: test skill\n---\nbody\n`
    );
  }
}

export async function runSetup(packDir: string, env: SetupEnv) {
  const childEnv: Record<string, string> = {
    HOME: env.home,
    PATH: `${toPosixPath(env.stubBin)}:${BUN_DIR}:${CORE_DIR}`,
  };
  // MSYS bash wants these for its own runtime init; harmless passthrough.
  for (const key of ["SYSTEMROOT", "windir", "TEMP", "TMP"]) {
    const v = process.env[key];
    if (v) childEnv[key] = v;
  }
  const proc = Bun.spawn([BASH!, join(packDir, "setup").replaceAll("\\", "/")], {
    env: childEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}
