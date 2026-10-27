/**
 * Where a command's words point: path scope against the working directory,
 * persistence targets, and the secret-path patterns. The one filesystem lookup
 * (`realpath`) is injected, so the module reads no disk of its own.
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";

import { baseName } from "#src/utils.ts";

import { GLOB } from "./syntax.ts";
import type { Arg, FactsContext, Invocation, PathScope } from "./types.ts";

export const BUILD_NAMES = new Set([
  "node_modules",
  "dist",
  "build",
  "target",
  ".next",
  "__pycache__",
  ".cache",
  "coverage",
]);

export const SENSITIVE_PATH =
  /(^|\/)(\.ssh|\.aws|\.gnupg|\.netrc|\.npmrc|\.pgpass|\.git-credentials|\.docker\/config\.json|\.kube\/config|id_(rsa|ed25519|ecdsa|dsa)|authorized_keys|credentials|shadow)(\/|$)|(^|[/=@])\.env($|\.)|\.(pem|p12|pfx)$|^\/proc\/[^/]+\/environ$/;

export const PUBLIC_SYSTEM_PATH =
  /^\/(etc\/(hostname|os-release|timezone|hosts)|proc\/(cpuinfo|meminfo|version|uptime))$/;

const FILE_COMMANDS = new Set([
  "rm",
  "rmdir",
  "cat",
  "cp",
  "mv",
  "touch",
  "ln",
  "chmod",
  "chown",
  "ls",
  "stat",
  "tar",
  "grep",
  "find",
  "dd",
  "mkdir",
  "head",
  "tail",
  "less",
  "more",
  "sed",
  "awk",
  "tee",
  "wc",
  "diff",
  "sort",
  "file",
  "du",
  "install",
  "shred",
  "truncate",
]);

// Whether a `chmod` wording sets any group or other permission bit.
//
// The words are all this reads: no prior mode is visible, so `chmod 440` on a
// key reads true (group-readable) even though it may be a tightening from 644.
// `chmod 600`, `chmod u+x`, `chmod go-rwx` read false — none of them grants a
// class wider than the owner.
export function grantsBeyondOwner(args: readonly { text: string }[]): boolean {
  for (const arg of args) {
    const text = arg.text;
    if (/^[0-7]{3,4}$/.test(text)) {
      const last = text.slice(-3);
      if (Number(last[1]) > 0 || Number(last[2]) > 0) return true;
      continue;
    }
    const set = /^([ugoa]*)=([rwxXst]*)$/.exec(text);
    if (set) {
      if (set[2] === "") continue;
      if (set[1] === "" || /[goa]/.test(set[1])) return true;
      continue;
    }
    const add = /^([ugoa]*)\+[rwxXst]+$/.exec(text);
    if (add && (add[1] === "" || /[goa]/.test(add[1]))) return true;
  }
  return false;
}

/** Read-only verbs: the code verb table reads each as `read`. */
export const READ_ONLY_COMMANDS = new Set([
  "cat",
  "ls",
  "stat",
  "head",
  "tail",
  "less",
  "more",
  "grep",
  "wc",
  "diff",
  "file",
  "du",
  "find",
]);

/**
 * The git hook names a runner installs under `.husky/`. A write to one of these
 * takes effect on the next git operation, exactly like `.git/hooks/<name>`;
 * husky's own shim under `.husky/_/<name>` counts the same way.
 */
const HUSKY_HOOKS = new Set([
  "applypatch-msg",
  "pre-applypatch",
  "post-applypatch",
  "pre-commit",
  "pre-merge-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-commit",
  "pre-rebase",
  "post-checkout",
  "post-merge",
  "pre-push",
  "pre-receive",
  "update",
  "proc-receive",
  "post-receive",
  "post-update",
  "reference-transaction",
  "push-to-checkout",
  "pre-auto-gc",
  "post-rewrite",
  "sendemail-validate",
  "fsmonitor-watchman",
  "p4-changelist",
  "p4-prepare-changelist",
  "p4-post-changelist",
  "p4-pre-submit",
  "post-index-change",
]);

const STARTUP_FILES = new Set([
  ".bashrc",
  ".zshrc",
  ".profile",
  ".bash_profile",
  ".bash_login",
  ".zprofile",
  ".zshenv",
]);

const defaultRealpath = (p: string): string | null => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};

export class PathResolver {
  private readonly cwd: string;
  private readonly home: string;
  private readonly real: (p: string) => string | null;
  private readonly realCwd: string;
  private readonly scratchRoots: string[];

  constructor(ctx: FactsContext) {
    this.cwd = resolve(ctx.cwd);
    this.home = ctx.home ?? homedir();
    this.real = ctx.realpath ?? defaultRealpath;
    this.realCwd = this.real(this.cwd) ?? this.cwd;
    this.scratchRoots = ["/tmp", "/var/tmp"].flatMap((r) => {
      const real = this.real(r);
      return real && real !== r ? [r, real] : [r];
    });
  }

  expand(text: string): string | null {
    if (text === "~") return this.home;
    if (text.startsWith("~/")) return resolve(this.home, text.slice(2));
    if (text.startsWith("~")) return null;
    return isAbsolute(text) ? resolve(text) : resolve(this.cwd, text);
  }

  // Longest existing prefix, symlinks resolved, remainder appended lexically.
  realOf(abs: string): string {
    let head = abs;
    const tail: string[] = [];
    for (;;) {
      const real = this.real(head);
      if (real !== null) return tail.length ? resolve(real, ...tail.toReversed()) : real;
      const parent = resolve(head, "..");
      if (parent === head) return abs;
      tail.push(head.slice(parent.length).replace(/^[/\\]+/, ""));
      head = parent;
    }
  }

  scope(arg: Arg, cdSeen: boolean): PathScope {
    if (!arg.literal || GLOB.test(arg.text) || arg.text.includes("$")) return "unknown";
    const text = arg.text;
    const relative = !isAbsolute(text) && !text.startsWith("~");
    if (cdSeen && relative) return "unknown";
    const abs = this.expand(text);
    if (abs === null) return "unknown";
    const segments = text.split("/");
    const dotdot = segments.indexOf("..");
    if (dotdot > 0) {
      const prefix = this.expand(segments.slice(0, dotdot).join("/") || ".");
      if (prefix !== null && this.realOf(prefix) !== prefix) return "unknown";
    }
    const real = this.realOf(abs);
    if (this.within(real, this.realCwd)) return "inside";
    for (const root of this.scratchRoots) {
      if (real !== root && this.within(real, root)) return "scratch";
    }
    return "outside";
  }

  // The first segment below the project, or the cache directory under home.
  buildRoot(arg: Arg): boolean {
    if (!arg.literal || GLOB.test(arg.text) || arg.text.includes("$")) return false;
    const abs = this.expand(arg.text);
    if (abs === null) return false;
    const real = this.realOf(abs);
    if (this.within(real, this.realCwd) && this.within(abs, this.cwd)) {
      const first = abs.slice(this.cwd.length + 1).split(sep)[0] ?? "";
      return BUILD_NAMES.has(first);
    }
    return this.within(abs, resolve(this.home, ".cache")) && abs !== resolve(this.home, ".cache");
  }

  private within(path: string, root: string): boolean {
    return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
  }
}

export const rank: Record<PathScope, number> = {
  none: 0,
  scratch: 1,
  inside: 2,
  outside: 3,
  unknown: 4,
};

export function pathArgs(inv: Invocation): Arg[] {
  const name = inv.name ?? "";
  const fileCommand = FILE_COMMANDS.has(name);
  let args = inv.args;
  if (name === "find") {
    const stop = args.findIndex((a) => /^[-(!]/.test(a.text));
    args = stop < 0 ? args : args.slice(0, stop);
  }
  // A bare test (`[ -n "$KEY" ]`) never expands its words to paths: the
  // variable is compared in-process, never read as a file. Its expansions
  // carry no scope signal, so they are dropped here (the `secretVariable`
  // rule still sees the raw command text).
  if (name === "[" || name === "test") return [];
  const out: Arg[] = [];
  for (const arg of args) {
    let text = arg.text;
    if (text.startsWith("--") && text.includes("=")) text = text.slice(text.indexOf("=") + 1);
    else if (text.startsWith("-") && text !== "-") continue;
    const dd = name === "dd" ? /^(?:of|if)=(.*)$/.exec(text) : null;
    if (dd) text = dd[1] ?? "";
    text = text.replace(/^@/, "");
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^\d+$/.test(text)) continue;
    // An empty NON-literal is a pure expansion (`rm -rf $DIR` parses the value
    // to nothing): it is not "no argument" but "an argument the record cannot
    // read". Keep it so the scope reader rates it unknown; drop only empty
    // literals, which carry no expansion at all.
    if (text === "" && arg.literal) continue;
    if (text === "" && !arg.literal) {
      out.push({ text, literal: false });
      continue;
    }
    const pathLike = /[/~]/.test(text) || text.startsWith(".");
    if (!fileCommand && !pathLike) continue;
    if (!fileCommand && (/\s/.test(text) || (arg.literal && text.includes("=")))) continue;
    out.push({ text, literal: arg.literal });
  }
  return out;
}

export const IGNORED_REDIRECT_TARGET =
  /^(\/dev\/(null|stdout|stderr|stdin|tty)|\/dev\/(tcp|udp)\/.*|\d+|-)$/;
export function redirectPaths(inv: Invocation): Arg[] {
  return inv.redirects
    .filter(
      (r) => !/^<<|^<<</.test(r.op) && !(r.op.endsWith("&") && /^\d+$|^-$/.test(r.target.text)),
    )
    .map((r) => r.target)
    .filter((t) => !IGNORED_REDIRECT_TARGET.test(t.text));
}

export function isPersistencePath(text: string): boolean {
  if (/(^|\/)\.git\/hooks\//.test(text)) return true;
  // A husky hook is the same install as a `.git/hooks/` one, just at the path
  // the runner manages. The basename must be a hook name: writing
  // `.husky/README.md` or creating the directory installs nothing.
  if (/(^|\/)\.husky\//.test(text) && HUSKY_HOOKS.has(baseName(text))) {
    return true;
  }
  if (
    /^\/etc\/(profile\.d\/|cron|systemd\/)|(^|\/)\.config\/(autostart|systemd\/user)\//.test(text)
  )
    return true;
  return STARTUP_FILES.has(baseName(text));
}

/** The path evidence one command text provides, read in a single pass. */
export interface PathScan {
  /** Arguments the text reads a path from. */
  readonly reads: readonly Arg[];
  /** Redirect targets the text writes. */
  readonly writes: readonly Arg[];
  /** A write that installs something outliving the session (startup file, hook, enabled unit). */
  readonly persistence: boolean;
  /** A permission set that grants more than the file's owner had (`chmod +s`, `4755`). */
  readonly grants: boolean;
  /** Whether the text changes directory, so a relative path no longer means the working directory. */
  readonly cdSeen: boolean;
}

/**
 * Read every path-shaped fact from the invocations.
 *
 * @param invs - The invocations the walker collected.
 * @returns The reads, writes, persistence and permission evidence.
 */
export function scanPaths(invs: readonly Invocation[]): PathScan {
  const reads: Arg[] = [];
  const writes: Arg[] = [];
  let persistence = false;
  let grants = false;
  let cdSeen = false;

  for (const inv of invs) {
    const name = inv.name;
    const texts = inv.args.map((a) => a.text);
    const paths = pathArgs(inv);
    const redirected = redirectPaths(inv);
    reads.push(...paths);
    writes.push(...redirected);
    if (name === "cd" || name === "pushd" || name === "popd") cdSeen = true;
    // `crontab -l` lists and `crontab <file>` installs from a file the operator
    // already sees; a bare `crontab` reads stdin and `-r`/`-e` change the table.
    if (
      name === "crontab" &&
      (texts.length === 0 || !texts.includes("-l") || texts.includes("-r") || texts.includes("-e"))
    ) {
      persistence = true;
    }
    if (name === "systemctl" && texts.some((t) => t === "enable" || t === "link")) {
      persistence = true;
    }
    if (name === "chmod" && grantsBeyondOwner(inv.args)) grants = true;
    const reader = name !== null && READ_ONLY_COMMANDS.has(name);
    if (redirected.some((a) => isPersistencePath(a.text))) persistence = true;
    if (!reader && paths.some((a) => isPersistencePath(a.text))) persistence = true;
  }

  return { reads, writes, persistence, grants, cdSeen };
}

/**
 * The widest scope any of the words reaches.
 *
 * @param args - The read and written words.
 * @param resolver - The scope resolver (its one filesystem lookup is injected).
 * @param cdSeen - Whether the text changed directory.
 * @param initial - The scope before any word is read.
 * @returns The widest scope, ranked so a later word can only widen it.
 */
export function widestScope(
  args: readonly Arg[],
  resolver: PathResolver,
  cdSeen: boolean,
  initial: PathScope,
): PathScope {
  let scope = initial;
  for (const arg of args) {
    const read = resolver.scope(arg, cdSeen);
    if (rank[read] > rank[scope]) scope = read;
  }
  return scope;
}
