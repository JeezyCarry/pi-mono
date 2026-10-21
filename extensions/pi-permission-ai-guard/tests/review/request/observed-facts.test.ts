import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { observePackageScript, snapshotObservedFacts } from "#src/review/request/observed-facts.ts";

// POSIX-only coverage: when coreutils `mkfifo` is absent the FIFO test is
// skipped — the O_NOFOLLOW|O_NONBLOCK open it pins is the same path the
// symlink and oversize refusals exercise.
const MKFIFO_AVAILABLE = (() => {
  try {
    execFileSync("mkfifo", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

let dir: string;

beforeAll(() => {
  dir = join(tmpdir(), `observed-facts-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      scripts: {
        migrate: "node scripts/migrate-db.js",
        build: "tsc -p .",
        premigrate: "echo backing up",
      },
    }),
  );
  const badDir = join(tmpdir(), `observed-facts-bad-${process.pid}`);
  mkdirSync(badDir, { recursive: true });
  // A manifest with a non-string member: any evidence from this table is
  // incomplete, never silently cleaned.
  writeFileSync(
    join(badDir, "package.json"),
    JSON.stringify({ scripts: { ok: "echo hi", 123: 456 } }),
  );
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(join(tmpdir(), `observed-facts-bad-${process.pid}`), { recursive: true, force: true });
});

describe("observePackageScript", () => {
  it("reports the script text with source, scope, runner, and keys", () => {
    expect(observePackageScript("npm run migrate", dir)).toEqual({
      source: "package.json:scripts.migrate",
      runner: "npm",
      scripts: {
        premigrate: "echo backing up",
        migrate: "node scripts/migrate-db.js",
      },
      scope: "entry-declaration-only",
      lifecycleDeclared: true,
      keys: ["premigrate", "migrate"],
      manifestDir: dir,
    });
  });

  it("does not follow the script into downstream files", () => {
    // The evidence is the entry's declaration, not the callee's content.
    const out = observePackageScript("npm run migrate", dir);
    if (out.source === null) throw new Error("expected evidence");
    expect(out.scope).toBe("entry-declaration-only");
    expect(out.scripts["migrate"]).toBe("node scripts/migrate-db.js");
  });

  it("reports a non-string entry as incomplete, not evidence", () => {
    // A table with a non-string member is not silently cleaned into normal
    // evidence — the whole read reports incomplete.
    const bad = join(tmpdir(), `observed-facts-bad-${process.pid}`);
    expect(observePackageScript("npm run ok", bad)).toEqual({
      source: null,
      reason: "incomplete-scripts",
    });
  });

  it("accepts all four runners' explicit run form and names the runner", () => {
    for (const runner of ["npm", "pnpm", "yarn", "bun"]) {
      const out = observePackageScript(`${runner} run migrate`, dir);
      if (out.source === null) throw new Error(`expected evidence for ${runner}`);
      expect(out.source).toBe("package.json:scripts.migrate");
      expect(out.runner).toBe(runner);
    }
  });

  it("reports whether pre/post lifecycle text is declared, not whether it runs", () => {
    // `migrate` has a `premigrate` attached in the fixture → declared.
    // `build` has neither pre nor post → not declared. Declared text is
    // not a guarantee it will run (npm/pnpm/bun auto-run hooks, yarn berry
    // needs an explicit call, ignore-scripts suppresses any of them) — the
    // evidence reports the declaration, never execution.
    const withPre = observePackageScript("npm run migrate", dir);
    if (withPre.source === null) throw new Error("expected evidence");
    expect(withPre.lifecycleDeclared).toBe(true);
    expect(withPre.keys).toEqual(["premigrate", "migrate"]);
    const bare = observePackageScript("npm run build", dir);
    if (bare.source === null) throw new Error("expected evidence");
    expect(bare.lifecycleDeclared).toBe(false);
    expect(bare.keys).toEqual(["build"]);
  });

  it("refuses every shape but the explicit `<runner> run <name>`", () => {
    const unsupported = [
      "npm run migrate && npm test",
      "npm run migrate; echo done",
      "npm run migrate | tee out",
      "npm run --silent migrate",
      "npm migrate extra",
      "npm install",
      "npm test",
      "npm start",
      "pnpm build",
      "yarn build",
      "ls -la",
      "npm run ../escape",
      "npm run $(whoami)",
      "npm run `id`",
      "npm run a > out",
      "npm run 'quoted'",
      'npm run "quoted"',
      "FOO=1 npm run migrate",
      "npm run migrate > out",
      "npm run",
      "npm run a b",
    ];
    for (const cmd of unsupported) {
      expect(observePackageScript(cmd, dir)).toEqual({
        source: null,
        reason: "unsupported-shape",
      });
    }
  });

  it("reports a missing script without inventing evidence", () => {
    expect(observePackageScript("npm run nosuch", dir)).toEqual({
      source: null,
      reason: "no-such-script",
    });
  });

  it("reports a missing package.json without inventing evidence", () => {
    // No package anywhere up the ancestry: nothing to claim.
    const isolated = join(tmpdir(), `observed-facts-isolated-${process.pid}`);
    mkdirSync(isolated, { recursive: true });
    try {
      expect(observePackageScript("npm run migrate", join(isolated, "nowhere"))).toEqual({
        source: null,
        reason: "no-package-json",
      });
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });

  it("locates the owning package from a nested source subdirectory", () => {
    // cwd inside packages/a/src resolves to the owning packages/a/package.json
    // (the nearest valid manifest), not a monorepo root lookup.
    const nested = join(dir, "packages", "a", "src");
    mkdirSync(nested, { recursive: true });
    try {
      const out = observePackageScript("npm run migrate", nested);
      expect(out).toMatchObject({
        source: "package.json:scripts.migrate",
        scripts: { migrate: "node scripts/migrate-db.js" },
        // The owning package is the root fixture — the evidence names the
        // directory it was read from.
        manifestDir: dir,
      });
    } finally {
      rmSync(join(dir, "packages"), { recursive: true, force: true });
    }
  });

  it("stops the ancestor walk at the depth cap", () => {
    // The walk tries the cwd plus seven ancestors. A manifest exactly at the
    // last reachable level is found; one further up is out of reach, so a cwd
    // far from any package cannot claim an unrelated manifest near the root.
    const base = join(tmpdir(), `observed-depth-${process.pid}`);
    let deep = base;
    for (let i = 0; i < 8; i++) deep = join(deep, "d");
    mkdirSync(deep, { recursive: true });
    try {
      // base/d/d/d/d/d/d/d is seven levels up from base/d/.../d — reachable.
      const reachable = join(base, "d", "d", "d", "d", "d", "d", "d");
      writeFileSync(
        join(reachable, "package.json"),
        JSON.stringify({ scripts: { migrate: "node reachable.js" } }),
      );
      expect(observePackageScript("npm run migrate", deep)).toMatchObject({
        source: "package.json:scripts.migrate",
        scripts: { migrate: "node reachable.js" },
      });
      rmSync(join(reachable, "package.json"));
      writeFileSync(
        join(base, "package.json"),
        JSON.stringify({ scripts: { migrate: "node out-of-reach.js" } }),
      );
      expect(observePackageScript("npm run migrate", deep)).toEqual({
        source: null,
        reason: "no-package-json",
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("stops at a broken direct manifest — never a throw, never a parent skip", () => {
    const bad = join(tmpdir(), `observed-bad-${process.pid}`);
    mkdirSync(bad, { recursive: true });
    try {
      writeFileSync(join(bad, "package.json"), "not json{");
      expect(observePackageScript("npm run migrate", bad)).toEqual({
        source: null,
        reason: "unreadable-manifest",
      });
      writeFileSync(join(bad, "package.json"), "null");
      expect(observePackageScript("npm run migrate", bad)).toEqual({
        source: null,
        reason: "unreadable-manifest",
      });
      writeFileSync(join(bad, "package.json"), "[]");
      expect(observePackageScript("npm run migrate", bad)).toEqual({
        source: null,
        reason: "unreadable-manifest",
      });
      writeFileSync(join(bad, "package.json"), "{}");
      expect(observePackageScript("npm run migrate", bad)).toEqual({
        source: null,
        reason: "no-such-script",
      });
    } finally {
      rmSync(bad, { recursive: true, force: true });
    }
  });

  it("does not borrow a parent's same-named script past a broken child manifest", () => {
    // The walk must not skip the child's broken manifest and resolve the
    // name from the parent's table: the package owning the cwd is the
    // child, and its manifest is present but unusable.
    const root = join(tmpdir(), `observed-unreadable-child-${process.pid}`);
    const child = join(root, "sub");
    mkdirSync(child, { recursive: true });
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ scripts: { migrate: "node parent.js" } }),
      );
      writeFileSync(join(child, "package.json"), "broken{");
      expect(observePackageScript("npm run migrate", child)).toEqual({
        source: null,
        reason: "unreadable-manifest",
      });
      // With the child manifest healed the same lookup resolves to the
      // child's own script, manifestDir included.
      writeFileSync(
        join(child, "package.json"),
        JSON.stringify({ scripts: { migrate: "node child.js" } }),
      );
      expect(observePackageScript("npm run migrate", child)).toMatchObject({
        source: "package.json:scripts.migrate",
        scripts: { migrate: "node child.js" },
        manifestDir: child,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("freezes the Statement scope: background runs, negation refuses", () => {
    // `&` runs the same command in the background — the entry evidence
    // stands. `!` inverts execution — the shape is unsupported, not guessed.
    const bg = observePackageScript("npm run migrate &", dir);
    if (bg.source === null) throw new Error("expected evidence for background");
    expect(bg.source).toBe("package.json:scripts.migrate");
    expect(observePackageScript("! npm run migrate", dir)).toEqual({
      source: null,
      reason: "unsupported-shape",
    });
  });

  it("refuses a symlinked package.json", () => {
    const sec = join(tmpdir(), `observed-sec-${process.pid}`);
    mkdirSync(sec, { recursive: true });
    try {
      writeFileSync(join(sec, "real.json"), JSON.stringify({ scripts: { migrate: "node a.js" } }));
      // A leaf symlink to a valid manifest: refused at open (O_NOFOLLOW),
      // never followed. The walk levels each open their own package.json
      // path, so the link is exercised by pointing a level at a dir whose
      // package.json is a link — the refusal is a reason, never a follow.
      const linkDir = join(sec, "linked");
      mkdirSync(linkDir, { recursive: true });
      symlinkSync(join(sec, "real.json"), join(linkDir, "package.json"));
      expect(observePackageScript("npm run migrate", linkDir)).toEqual({
        source: null,
        reason: "unreadable-manifest",
      });
    } finally {
      rmSync(sec, { recursive: true, force: true });
    }
  });

  it.runIf(MKFIFO_AVAILABLE)("refuses a FIFO package.json immediately instead of blocking", () => {
    const fifoDir = join(tmpdir(), `observed-fifo-${process.pid}`);
    mkdirSync(fifoDir, { recursive: true });
    try {
      execFileSync("mkfifo", [join(fifoDir, "package.json")]);
      const started = Date.now();
      expect(observePackageScript("npm run migrate", fifoDir)).toEqual({
        source: null,
        reason: "unreadable-manifest",
      });
      // The open is O_NONBLOCK: waiting for a FIFO writer would hang the
      // caller (vitest's per-test timeout backstops this same failure).
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      rmSync(fifoDir, { recursive: true, force: true });
    }
  });

  it("refuses an oversize manifest without guessing", () => {
    const bigDir = join(tmpdir(), `observed-oversize-${process.pid}`);
    mkdirSync(bigDir, { recursive: true });
    try {
      // Over the cap: the whole read is refused, never truncated into
      // evidence.
      const filler = "x".repeat(1_048_576 + 1);
      writeFileSync(
        join(bigDir, "package.json"),
        JSON.stringify({ scripts: { migrate: `node ${filler}` } }),
      );
      expect(observePackageScript("npm run migrate", bigDir)).toEqual({
        source: null,
        reason: "unreadable-manifest",
      });
    } finally {
      rmSync(bigDir, { recursive: true, force: true });
    }
  });
});

describe("snapshotObservedFacts", () => {
  it("snapshots once for bash entries, null otherwise", () => {
    const out = snapshotObservedFacts("bash", "npm run migrate", dir);
    if (!out || out.source === null) throw new Error("expected evidence");
    expect(out.source).toBe("package.json:scripts.migrate");
    expect(snapshotObservedFacts("tool", "npm run migrate", dir)).toBeNull();
    expect(snapshotObservedFacts("bash", undefined, dir)).toBeNull();
  });

  it("freezes the snapshot — nested records are immutable", () => {
    const out = snapshotObservedFacts("bash", "npm run migrate", dir);
    if (!out || out.source === null) throw new Error("expected evidence");
    expect(Object.isFrozen(out)).toBe(true);
    expect(Object.isFrozen(out.scripts)).toBe(true);
    expect(Object.isFrozen(out.keys)).toBe(true);
  });
});
