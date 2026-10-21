/**
 * Observed facts — read-only evidence about what an action's entry point
 * declares, without executing anything.
 *
 * Scope (first slice): the explicit `<runner> run <name>` form, where
 * runner is one of npm, pnpm, yarn, or bun. Shape recognition runs on the
 * shell AST from `aliou/sh` (the same parser the pigment lane uses) — a lone simple
 * command of three bare literal words — not on string matching, so quoting,
 * expansion, redirection, chaining, substitution, and every other shell
 * syntax fails closed through the parse itself. Bare shorthands (`npm test`,
 * `npm start` — which carry default behaviors when the script is absent),
 * extra args, flags, and assignments are out of scope and report
 * `unsupported-shape`. So are each manager's fallbacks beyond the current
 * package's scripts table (yarn's dependency binaries and colon-scoped
 * cross-workspace scripts, pnpm's `-r` recursion): the evidence states what
 * the current package declares; anything else is `no-such-script`, not a
 * guess. Narrow on purpose: finding a same-named script does not prove the
 * real command would execute it. Lifecycle (pre/post) text is included as
 * declared: `lifecycleDeclared` states whether the pre/post entries are
 * attached — attached never means executed (npm, pnpm, and bun run those
 * hooks automatically, yarn berry does not — custom pre/post need an
 * explicit call — and manager configuration (`ignore-scripts` and friends)
 * can further change what actually runs).
 *
 * The evidence carries an explicit range statement: the named script plus
 * its pre/post lifecycle text. Downstream files the script text invokes are
 * NOT followed — `scope` says so, and the verdict layer must not read the
 * text as the full effect. Showing script text does not prove safety
 * (visible-but-dangerous still denies); absence is a reason, never safety.
 *
 * What this does NOT do: it does not read the authorization anchor (an
 * anchor naming the action is authorization evidence, not effect evidence —
 * the two remain separate).
 *
 * Read boundaries: the owning package's `package.json` — the first ancestor
 * (walking up from `workingDirectory`, at most {@link PACKAGE_JSON_MAX_DEPTH}
 * levels) whose `package.json` is a regular, readable file that parses to an
 * object. A candidate that exists but cannot be read as a manifest (refused
 * open, non-regular file, oversize, or malformed JSON) STOPS the walk with
 * `unreadable-manifest` — a broken direct manifest must not be skipped in
 * favor of a parent's same-named script. Each candidate is opened
 * once as a file descriptor — symlink refused, regular-file verified by
 * fstat, at most the cap plus one byte read, always closed. Every failure is
 * an absence reason. The caller snapshots once per review (see
 * `snapshotObservedFacts`); renderers and the cache key consume the frozen
 * snapshot, never the disk.
 */

import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { dirname, join } from "node:path";

import { parse, type SimpleCommand, type Statement } from "@aliou/sh";

import { bareLiteral } from "#src/review/request/shell-ast.ts";
import { deepFreeze } from "#src/utils.ts";

/** Upper bound on the package.json bytes read — a manifest, not a dump. */
const PACKAGE_JSON_MAX_BYTES = 1_048_576;

/**
 * How many ancestor directories (including `workingDirectory` itself) the
 * owning-package lookup tries before giving up. Monorepo package roots sit
 * within a few levels of a source subdirectory; the bound keeps a cwd far
 * from any package from walking to an unrelated manifest near the filesystem
 * root.
 */
const PACKAGE_JSON_MAX_DEPTH = 8;

/** Name characters the producer accepts — anything else is not parsed. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_:.-]*$/;

/** Why no evidence was produced. */
export type ObservedFactsReason =
  | "unsupported-shape"
  | "no-package-json"
  | "unreadable-manifest"
  | "no-such-script"
  | "incomplete-scripts";

/**
 * Entry-declaration evidence: the script text npm would run for the event,
 * with an explicit statement of what was and was not resolved.
 */
export interface ObservedFactsEvidence {
  readonly source: string;
  /** The runner the ask named; `source` is relative to the owning package. */
  readonly runner: ScriptRunner;
  readonly scripts: Readonly<Record<string, string>>;
  /**
   * What the evidence covers: the entry declaration only. Downstream files
   * the script text invokes were not read, and npm configuration can change
   * what actually runs.
   */
  readonly scope: "entry-declaration-only";
  /**
   * Whether the manifest declares the pre/post lifecycle entries
   * (`pre<name>` / `post<name>`) alongside the named script. Declared is
   * NOT executed: npm, pnpm, and bun run those hooks automatically, yarn
   * berry does not (custom pre/post need an explicit call), and manager
   * configuration (`ignore-scripts`) can suppress any of them — the
   * evidence states what the manifest declares, never what will run.
   */
  readonly lifecycleDeclared: boolean;
  /** The lifecycle keys included (`pre<name>` / `<name>` / `post<name>`). */
  readonly keys: readonly string[];
  /**
   * The directory of the manifest the evidence came from — the owning
   * package's root. Lets a reader see which package a declaration belongs
   * to when the cwd sits inside a nested source tree.
   */
  readonly manifestDir: string;
}

/** One observed fact: entry-declaration evidence, or a reason for absence. */
export type ObservedFacts =
  | ({ readonly source: string } & ObservedFactsEvidence)
  | { readonly source: null; readonly reason: ObservedFactsReason };

/** The runners whose explicit `run <name>` form this producer recognizes. */
type ScriptRunner = "npm" | "pnpm" | "yarn" | "bun";

/**
 * The runners' explicit `run <name>` forms this producer recognizes. All four
 * resolve the name against the current package's scripts table first
 * (npm `run.js`, pnpm `run`, yarn berry `run.ts`, bun `run`); their fallbacks
 * beyond it are out of scope (see the module banner).
 */
const SCRIPT_RUNNERS: ReadonlySet<string> = new Set<ScriptRunner>(["npm", "pnpm", "yarn", "bun"]);

/** The explicit `<runner> run <name>` form's two parts. */
interface ScriptRunName {
  readonly runner: ScriptRunner;
  readonly name: string;
}

/**
 * Extract the script name and runner from the explicit
 * `<runner> run <name>` form, recognized on the AST: the program is one
 * statement whose command is a lone simple command with no assignments or
 * redirects, and whose three words are bare literals. Statement modifiers
 * are read, not dropped: a trailing `&` (background) runs the same command
 * so the evidence stands; a leading `!` (negation) inverts execution so the
 * shape is unsupported. Every other shape — unknown runners, bare
 * shorthands, flags, extra args, any other shell syntax — is unsupported,
 * not guessed.
 *
 * @param command - The full shell command text.
 * @returns `{ runner, name }` when recognized, else null.
 */
function parseScriptRunName(command: string): ScriptRunName | null {
  let program;
  try {
    program = parse(command).ast;
  } catch {
    return null;
  }
  if (!program || program.body.length !== 1) return null;
  const stmt = program.body[0] as Statement | undefined;
  if (!stmt || stmt.type !== "Statement" || stmt.negated === true) return null;
  const inner = stmt.command;
  if (!inner || inner.type !== "SimpleCommand") return null;
  const cmd = inner as SimpleCommand;
  if ((cmd.assignments?.length ?? 0) > 0 || (cmd.redirects?.length ?? 0) > 0) {
    return null;
  }
  const words = cmd.words ?? [];
  if (words.length !== 3) return null;
  const runner = bareLiteral(words[0]);
  if (!runner || !SCRIPT_RUNNERS.has(runner) || bareLiteral(words[1]) !== "run") {
    return null;
  }
  const name = bareLiteral(words[2]);
  if (!name || !SAFE_NAME.test(name)) return null;
  return { runner: runner as ScriptRunner, name };
}

/** A capped file read: the text, or the presence signal the walk keys on. */
type FileRead =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable" };

/**
 * Read one capped regular file through a single fd. `missing` means the path
 * holds no file — the owning-package walk climbs past it. `unreadable` means
 * a file EXISTS but cannot be trusted as a manifest (refused open,
 * non-regular file, oversize, read error) — the walk must stop rather than
 * borrow a parent's same-named script.
 *
 * Open uses `O_NOFOLLOW | O_NONBLOCK`: a leaf symlink fails at open (never
 * followed), and a FIFO fails instead of blocking — the subsequent fstat
 * on the open descriptor (not the path) then verifies the regular file, so
 * a swap between check and read cannot redirect to a device. At most the
 * cap plus one byte is read; anything longer is refused. Always closed.
 *
 * @param path - The file path to open with O_NOFOLLOW|O_NONBLOCK.
 * @returns The file text, `missing`, or `unreadable`.
 */
function readCappedFile(path: string): FileRead {
  let fd = -1;
  try {
    // eslint-disable-next-line no-bitwise
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile()) return { kind: "unreadable" };
    // Cap plus one: anything longer is refused without learning its length.
    const buf = Buffer.alloc(PACKAGE_JSON_MAX_BYTES + 1);
    let at = 0;
    for (;;) {
      const n = readSync(fd, buf, at, buf.length - at, null);
      if (n === 0) break;
      at += n;
      if (at > PACKAGE_JSON_MAX_BYTES) return { kind: "unreadable" };
    }
    return { kind: "text", text: buf.toString("utf8", 0, at) };
  } catch (e) {
    // Absent (the leaf or a directory on the way does not exist) is the
    // climb signal; every other refusal is a file that exists but cannot
    // be read as a manifest.
    return (e as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "missing" }
      : { kind: "unreadable" };
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
        // The read already decided; a close failure adds no information.
      }
    }
  }
}

/**
 * Read the owning package's package.json and parse its scripts table. The
 * owning package is the nearest ancestor (starting at `workingDirectory`
 * itself) whose package.json is a regular, readable file that parses to an
 * object; the walk stops there — this finds the owning package, not the
 * monorepo root, and a cwd nested in `packages/a/src/` resolves to
 * `packages/a/package.json`. A candidate that EXISTS but cannot be read as
 * a manifest (refused open, oversize, or malformed JSON) stops the walk
 * with `unreadable-manifest`: a broken direct manifest must not be skipped
 * in favor of a parent's same-named script. At most
 * {@link PACKAGE_JSON_MAX_DEPTH} levels are tried so the walk cannot climb to
 * an unrelated manifest near the filesystem root.
 *
 * @param workingDirectory - The cwd to resolve the owning package from.
 * @returns The scripts table (with the owning package's directory), or the
 * absence reason.
 */
function readScriptsManifest(
  workingDirectory: string,
):
  | { scripts: Record<string, string>; incomplete: boolean; manifestDir: string }
  | { reason: ObservedFactsReason } {
  let current = workingDirectory;
  for (let depth = 0; depth < PACKAGE_JSON_MAX_DEPTH; depth++) {
    const read = readCappedFile(join(current, "package.json"));
    if (read.kind === "missing") {
      // No manifest here — the walk climbs to the next ancestor.
    } else if (read.kind === "unreadable") {
      // The manifest exists but cannot be trusted as one — stopping beats
      // skipping it and attributing a parent's same-named script to the
      // caller's package.
      return { reason: "unreadable-manifest" };
    } else {
      let pkg: unknown;
      try {
        pkg = JSON.parse(read.text) as unknown;
      } catch {
        pkg = undefined;
      }
      if (typeof pkg === "object" && pkg !== null && !Array.isArray(pkg)) {
        const manifest = pkg as Record<string, unknown>;
        const scripts = manifest["scripts"];
        if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) {
          return { reason: "no-such-script" };
        }
        // Prototype-free record: `__proto__` and friends cannot become entries.
        const out: Record<string, string> = Object.create(null) as Record<string, string>;
        let incomplete = false;
        for (const [k, v] of Object.entries(scripts)) {
          if (typeof v === "string") {
            out[k] = v;
          } else {
            // A non-string entry where text belongs: report, don't silently drop.
            incomplete = true;
          }
        }
        return { scripts: out, incomplete, manifestDir: current };
      }
      // The file exists and reads as text but is not an object manifest —
      // a broken direct manifest, not a package: stop rather than climb.
      return { reason: "unreadable-manifest" };
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { reason: "no-package-json" };
}

/**
 * Read the declared script text for an explicit `<runner> run <name>` entry.
 * Pure read of the owning package's capped regular file; every failure is a
 * reason.
 *
 * @param command - The full shell command text.
 * @param workingDirectory - The cwd to resolve the owning package from.
 * @returns Entry-declaration evidence, or the absence reason.
 */
export function observePackageScript(command: string, workingDirectory: string): ObservedFacts {
  const parsed = parseScriptRunName(command);
  if (!parsed) return { source: null, reason: "unsupported-shape" };
  const { runner, name } = parsed;
  const manifest = readScriptsManifest(workingDirectory);
  if ("reason" in manifest) return { source: null, reason: manifest.reason };
  if (!Object.prototype.hasOwnProperty.call(manifest.scripts, name)) {
    return { source: null, reason: "no-such-script" };
  }
  // npm semantics: pre/post lifecycle entries attach to the named event.
  const keys = [`pre${name}`, name, `post${name}`].filter((k) =>
    Object.prototype.hasOwnProperty.call(manifest.scripts, k),
  );
  if (manifest.incomplete) return { source: null, reason: "incomplete-scripts" };
  const picked: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const k of keys) picked[k] = manifest.scripts[k] as string;
  return deepFreeze({
    source: `package.json:scripts.${name}`,
    runner,
    scripts: picked,
    scope: "entry-declaration-only",
    // Attached pre/post text is not proof it will run — execution depends
    // on the runner and its configuration.
    lifecycleDeclared: keys.some((k) => k !== name),
    keys,
    manifestDir: manifest.manifestDir,
  });
}

/**
 * An immutable per-review snapshot of the observed facts. The pipeline calls
 * this once per review, before the cache lookup; the state, the cache key,
 * and both lane renderers consume the returned value, so a file change
 * mid-review cannot put B's verdict under A's key. The next review
 * re-snapshots.
 *
 * @param kind - The ask kind; only bash entries snapshot.
 * @param fullCommand - The full bash command, or undefined.
 * @param workingDirectory - The cwd to resolve the owning package from.
 * @returns The frozen snapshot, or null for non-bash entries.
 */
export function snapshotObservedFacts(
  kind: string,
  fullCommand: string | undefined,
  workingDirectory: string,
): ObservedFacts | null {
  if (kind !== "bash" || !fullCommand) return null;
  return observePackageScript(fullCommand, workingDirectory);
}
