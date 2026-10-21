/**
 * Deterministic command facts: what a command text demonstrably does, read from the
 * shell AST and the working directory alone — no model, no subprocess, no network.
 *
 * Every fact fails toward the conservative side. A word the walker cannot read, a
 * command it cannot parse, or a construct that hides what runs (`eval`, `$CMD`)
 * widens the path scope to `unknown` and the network class to `restricted`; the
 * decision table treats both as "not provably safe". A fact that raises scrutiny
 * (`publishesArtifact`, `dumpsEnvironment`, ...) is only set on positive evidence.
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";

import { parse } from "@aliou/sh";

/** Where the paths a command touches lie, relative to the working directory. */
export type PathScope = "inside" | "outside" | "scratch" | "none" | "unknown";

/**
 * Network reach of a command. `public` and `local` are provable from literal hosts;
 * anything else that touches the network (private or metadata addresses, hosts built
 * from variables, no literal host at all) is `restricted`.
 */
export type NetworkAccess = "none" | "local" | "public" | "restricted";

/** Environment the facts are computed against. */
export interface FactsContext {
  readonly cwd: string;
  readonly home?: string;
  /** Resolves symlinks of an existing path; null when the path does not exist. */
  readonly realpath?: (path: string) => string | null;
  /**
   * Declared project tasks (name to command line), e.g. from a package manifest; absent vouches for
   * nothing.
   */
  readonly declaredTasks?: Readonly<Record<string, string>>;
}

/**
 * What the command's verbs demonstrably do, from a closed verb table. `unknown` means at
 * least one verb is outside the table, so the code cannot vouch for what the command does.
 */
export type CommandEffect = "read" | "modify" | "delete" | "send_out" | "unknown";

/** The facts the classifier decision table reads. */
export interface CommandFacts {
  /** False when the text did not parse; the path and network facts are then conservative. */
  readonly parsed: boolean;
  readonly pathScope: PathScope;
  /** Every path word names a build or cache output directory inside the project. */
  readonly namedBuildOutput: boolean;
  readonly recursive: boolean;
  readonly publishesArtifact: boolean;
  readonly sensitivePathName: boolean;
  readonly publicSystemPath: boolean;
  readonly rewritesHistory: boolean;
  readonly rawCopy: boolean;
  readonly allInterfaces: boolean;
  readonly network: NetworkAccess;
  readonly dumpsEnvironment: boolean;
  readonly installsPersistence: boolean;
  /**
   * A `chmod` wording that sets any group or other permission bit. It reads the
   * words only and cannot see the prior mode, so it states "this asks for a
   * class wider than the owner", not "this widened the file". The table decides
   * whether the path makes that a protection question.
   */
  readonly grantsBeyondOwner: boolean;
  /** A network command in a sending shape (upload, POST, copy to a host, remote execution). */
  readonly sendsData: boolean;
  readonly commandEffect: CommandEffect;
  /** A variable whose name marks a secret (`$GITHUB_TOKEN`) is expanded. */
  readonly secretVariable: boolean;
  /**
   * A `-H`/`--header` value carrying a literal token (`Authorization:
   * Bearer ghp_...`). Symmetric with `secretVariable`: that one names
   * the secret by variable, this one by value. Joins the same
   * `credential` disjunction — read or send of a header token asks at
   * least as hard as a variable-named one.
   */
  readonly headerToken: boolean;
  /**
   * An auth-carrying header (`Authorization`, `Proxy-Authorization`,
   * `X-Api-Key`) whose value is an unreadable expansion (`$VAL`,
   * `$(...)`). Proven spellings are curl's `-H`/`--header` (separate and
   * attached) and `--header` on wget; wget's `-H` is `--span-hosts`, not
   * a header, and a whole-word expansion or a file reference cannot prove
   * a field name, so neither counts. The fact states "an authentication
   * value leaves in a form the record cannot show", never "this is a
   * credential": a request-id or content-type expansion must not trip
   * it, and a single-quoted (literal) value must not either. The table
   * reads it as an escalator — a named request still asks — rather than
   * as a credential row.
   */
  readonly authHeaderExpansion: boolean;
  /** A single literal project build, test or lint command recognized by name. */
  readonly routineDevCommand: boolean;
  /** A `/dev/tcp` or `/dev/udp` path in an argument or a redirect target (a shell socket). */
  readonly socketRedirection: boolean;
  /** A loop in the text also backgrounds a command: unbounded process spawn. */
  readonly unboundedSpawn: boolean;
}

const BUILD_NAMES = new Set([
  "node_modules",
  "dist",
  "build",
  "target",
  ".next",
  "__pycache__",
  ".cache",
  "coverage",
]);

/** The removal flag spellings the closed build-output shapes accept. */
const DELETE_FLAGS = new Set(["-r", "-R", "-f", "-rf", "-fr", "-Rf", "--recursive", "--force"]);

/** Bundled short removal flags: any combination of the four letters. */
const SHORT_REMOVAL_FLAGS = /^-[rRfv]+$/;

/** Long removal flags that do not change what the removal reaches. */
const LONG_REMOVAL_FLAGS = new Set(["--recursive", "--force", "--verbose"]);

/**
 * Whether one word is an acceptable argument to a removal in the free-exit
 * shape. Flags are a closed set — a removal whose behaviour the closed set
 * cannot spell (`--no-preserve-root`, `--one-file-system`, `-i`) reads false —
 * while a plain path word and the bare end-of-options `--` always pass.
 *
 * @param word - The argument word.
 * @returns True when the word leaves the removal's reach unchanged.
 */
function allowedRemovalWord(word: string): boolean {
  if (!word.startsWith("-") || word === "-" || word === "--") return true;
  return SHORT_REMOVAL_FLAGS.test(word) || LONG_REMOVAL_FLAGS.has(word);
}

/**
 * Whether a `find` invocation's `-exec` clause is exactly one build-output
 * removal. The clause licenses the free exit, so it is matched with argument
 * count exactness rather than by inspection: `-exec`, then `rm`, then one
 * accepted removal flag, then `{}`, then `+`, and nothing after. A different
 * command, a different flag set, `-execdir`, `;`-termination or any trailing
 * argument reads false — and false is the conservative side.
 *
 * @param args - The `find` invocation's argument words.
 * @returns True only for the closed `-exec rm <flag> {} +` tail.
 */
function execDeletesBuildOutput(args: readonly Arg[]): boolean {
  const at = args.findIndex((a) => a.text === "-exec");
  if (at < 0) return false;
  const tail = args.slice(at + 1).map((a) => a.text);
  return (
    tail.length === 4 &&
    tail[0] === "rm" &&
    DELETE_FLAGS.has(tail[1] ?? "") &&
    tail[2] === "{}" &&
    tail[3] === "+"
  );
}

const SENSITIVE_PATH =
  /(^|\/)(\.ssh|\.aws|\.gnupg|\.netrc|\.npmrc|\.pgpass|\.git-credentials|\.docker\/config\.json|\.kube\/config|id_(rsa|ed25519|ecdsa|dsa)|authorized_keys|credentials|shadow)(\/|$)|(^|[/=@])\.env($|\.)|\.(pem|p12|pfx)$|^\/proc\/[^/]+\/environ$/;

const PUBLIC_SYSTEM_PATH =
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
function grantsBeyondOwner(args: readonly { text: string }[]): boolean {
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
const READ_ONLY_COMMANDS = new Set([
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

/** Verbs a URL argument makes a network contact; a URL argument marks any verb. */
const NETWORK_COMMANDS = new Set([
  "curl",
  "wget",
  "nc",
  "ncat",
  "netcat",
  "socat",
  "ssh",
  "scp",
  "sftp",
  "rsync",
  "ftp",
  "telnet",
]);

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

// Wrappers that run another command; the value is the flags that take an argument.
const WRAPPERS: Readonly<Record<string, readonly string[]>> = {
  sudo: ["-u", "-g", "-h", "-p", "-C", "-r", "-t", "-T"],
  doas: ["-u", "-C"],
  nohup: [],
  time: [],
  command: [],
  exec: [],
  setsid: [],
  stdbuf: [],
  nice: ["-n"],
  ionice: ["-c", "-n", "-p"],
  timeout: ["-s", "-k"],
  xargs: ["-n", "-I", "-P", "-L", "-s", "-d", "-E", "-a"],
  env: ["-u", "-C", "-S"],
};

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

const MAX_SHELL_DEPTH = 3;

interface Arg {
  readonly text: string;
  /** True when the word is made of plain and quoted literals only. */
  readonly literal: boolean;
}

interface Redirect {
  readonly op: string;
  readonly target: Arg;
  /** True when the heredoc body carries expansion or quoting the reader declines. */
  readonly opaque?: boolean;
}

interface Invocation {
  /** The effective command after wrappers; null when it is not a literal word. */
  readonly name: string | null;
  readonly args: readonly Arg[];
  readonly redirects: readonly Redirect[];
  readonly dumpsEnv: boolean;
}

interface Collected {
  invocations: Invocation[];
  opaque: boolean;
  parsed: boolean;
  /** A `/dev/tcp` or `/dev/udp` path in any argument or redirect target. */
  socket: boolean;
  /** Any statement is backgrounded (`&`). */
  background: boolean;
  /** The text contains a loop construct. */
  loop: boolean;
  /** A loop whose termination the text cannot prove (`while`/`until`/C-style, or an expanding list). */
  unboundedLoop: boolean;
}

// A heredoc word that is one bare literal. Anything else expands like an
// unquoted heredoc, so it is unreadable as a kept word.
function bareWordFromParts(heredoc: unknown): string | null {
  if (!isNode(heredoc) || !Array.isArray(heredoc.parts) || heredoc.parts.length !== 1) return null;
  const part = heredoc.parts[0];
  if (!isNode(part) || part.type !== "Literal" || typeof part.value !== "string") return null;
  return part.value;
}

// A heredoc word that is one bare literal or one single-quoted word. Anything
// else expands like an unquoted heredoc, so it is unreadable as a kept word.
function singleQuotedWord(heredoc: unknown): string | null {
  if (!isNode(heredoc) || !Array.isArray(heredoc.parts) || heredoc.parts.length !== 1) return null;
  return bareWordFromParts(heredoc) ?? quotedPart(heredoc.parts[0]);
}

function quotedPart(part: unknown): string | null {
  if (!isNode(part) || part.type !== "SglQuoted" || typeof part.value !== "string") return null;
  return part.value;
}

/** A heredoc body as a text word, plus whether it may carry expansion. */
interface HeredocBody {
  readonly arg: Arg;
  readonly opaque: boolean;
}

// literals concatenate; a double-quoted span keeps its text but marks the
// body expanded; anything else (a variable, a substitution) is unreadable.
// A quoted delimiter (`<<'EOF'`) suppresses expansion: the body is exact.
// The parser does not expose the delimiter's quoting, and the body word
// carries no quoting trace either, so expansion is assumed: any `$` in the
// body marks it opaque. A body the parser did expand (a variable or
// substitution part) is opaque as well — it is no longer the request text.
function heredocBody(heredoc: unknown): HeredocBody | null {
  if (!isNode(heredoc) || !Array.isArray(heredoc.parts)) return null;
  let text = "";
  let opaque = false;
  for (const part of heredoc.parts) {
    if (!isNode(part)) return null;
    if (part.type === "Literal" || part.type === "SglQuoted") {
      const value = typeof part.value === "string" ? part.value : "";
      if (value.includes("$")) opaque = true;
      text += value;
    } else if (part.type === "DblQuoted") {
      opaque = true;
      for (const inner of Array.isArray(part.parts) ? part.parts : []) {
        if (!isNode(inner) || inner.type !== "Literal" || typeof inner.value !== "string")
          return null;
        text += inner.value;
      }
    } else return null;
  }
  return { arg: { text, literal: !opaque }, opaque };
}

type Node = { type?: string; [key: string]: unknown };

const isNode = (v: unknown): v is Node => typeof v === "object" && v !== null;

function wordArg(word: unknown): Arg {
  let text = "";
  let literal = true;
  const walk = (parts: unknown): void => {
    if (!Array.isArray(parts)) return;
    for (const part of parts) {
      if (!isNode(part)) continue;
      if (part.type === "Literal" || part.type === "SglQuoted") {
        text += typeof part.value === "string" ? part.value : "";
      } else if (part.type === "DblQuoted") {
        walk(part.parts);
      } else {
        literal = false;
      }
    }
  };
  if (isNode(word)) walk(word.parts);
  else literal = false;
  return { text, literal };
}

/**
 * The field word of a header option, for the spellings that let the reader
 * prove the field name: `--header <field>` and `--header=<field>` on both
 * tools, plus curl's `-H <field>` and attached `-H<field>`. wget's `-H` is
 * `--span-hosts`, not a header, so the short form is curl-only on purpose. A
 * whole-word expansion (`-H "$HEADER"`) or a file reference (`-H @file`)
 * cannot prove a field name and stays out (ADR 0011).
 *
 * @param inv - The invocation the word belongs to.
 * @param arg - The candidate option word.
 * @param index - The word's position, used to read the separate-form value.
 * @returns The field text and the word that carries it, or undefined.
 */
function headerField(
  inv: Invocation,
  arg: Arg,
  index: number,
): { field: string; word: Arg } | undefined {
  const next = inv.args[index + 1];
  if (arg.text === "--header") return next ? { field: next.text, word: next } : undefined;
  if (arg.text.startsWith("--header=")) {
    return { field: arg.text.slice("--header=".length), word: arg };
  }
  if (inv.name !== "curl") return undefined;
  if (arg.text === "-H") return next ? { field: next.text, word: next } : undefined;
  if (arg.text.length > 2 && arg.text.startsWith("-H")) {
    return { field: arg.text.slice(2), word: arg };
  }
  return undefined;
}

function stripWrappers(words: readonly Arg[]): {
  name: string | null;
  args: readonly Arg[];
  dumpsEnv: boolean;
} {
  let rest = words;
  let dumpsEnv = false;
  for (;;) {
    const head = rest[0];
    if (!head) return { name: null, args: [], dumpsEnv: dumpsEnv };
    if (!head.literal) return { name: null, args: rest.slice(1), dumpsEnv };
    const valueFlags = WRAPPERS[head.text];
    if (valueFlags === undefined) return { name: head.text, args: rest.slice(1), dumpsEnv };
    let i = 1;
    while (i < rest.length) {
      const a = rest[i];
      if (a === undefined) break;
      if (head.text === "env" && /^[A-Za-z_]\w*=/.test(a.text)) {
        i++;
        continue;
      }
      if (!a.text.startsWith("-") || a.text === "-") break;
      i += valueFlags.includes(a.text) ? 2 : 1;
    }
    if (head.text === "timeout" && /^\d/.test(rest[i]?.text ?? "")) i++;
    rest = rest.slice(i);
    if (rest.length === 0 && head.text === "env") return { name: null, args: [], dumpsEnv: true };
    if (rest.length === 0) return { name: null, args: [], dumpsEnv };
  }
}

function collect(node: unknown, out: Collected, depth: number): void {
  if (Array.isArray(node)) {
    for (const item of node) collect(item, out, depth);
    return;
  }
  if (!isNode(node)) return;
  if (node.type === "SimpleCommand" || node.type === "DeclClause") {
    addInvocation(node, out, depth);
  }
  if (node.type === "Statement" && node.background === true) out.background = true;
  // A `while`/`until`/C-style loop has no bound the text can show: termination
  // is unprovable, so it is unproven. A `for`/`select` over a finite literal
  // word list is bounded unless an item expands.
  if (node.type === "WhileClause" || node.type === "CStyleLoop") {
    out.loop = true;
    out.unboundedLoop = true;
  } else if (node.type === "ForClause" || node.type === "SelectClause") {
    out.loop = true;
    const items = Array.isArray(node.items) ? node.items : [];
    // Only a list of plain literals is a bound the text can show: a glob,
    // brace/extglob, expansion or empty list has an unprovable length.
    if (node.type === "SelectClause" || items.length === 0 || !items.every(wordIsFiniteLiteral)) {
      out.unboundedLoop = true;
    }
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "end" || key === "pos") continue;
    collect(value, out, depth);
  }
}

// Whether a loop item is a plain literal list word: no glob, no brace/extglob,
// no parameter or command substitution. Only then is its length provable.
function wordIsFiniteLiteral(word: unknown): boolean {
  if (!isNode(word) || !Array.isArray(word.parts) || word.parts.length === 0) return false;
  return word.parts.every(partIsFiniteLiteral);
}

function partIsFiniteLiteral(part: unknown): boolean {
  if (!isNode(part)) return false;
  if (part.type === "SglQuoted") return true;
  if (part.type === "DblQuoted") {
    return (
      Array.isArray(part.parts) && part.parts.length > 0 && part.parts.every(partIsFiniteLiteral)
    );
  }
  if (part.type === "Literal") {
    const value = typeof part.value === "string" ? part.value : "";
    return !GLOB.test(value) && !value.includes("{");
  }
  return false;
}

/** A `/dev/tcp` or `/dev/udp` path, bare or after `of=`/`=` (sockets are files). */
const SOCKET_PATH = /(^|=)\/dev\/(tcp|udp)\//;

function addInvocation(node: Node, out: Collected, depth: number): void {
  const redirects: Redirect[] = [];
  for (const r of Array.isArray(node.redirects) ? node.redirects : []) {
    if (isNode(r) && typeof r.op === "string") {
      const op = r.op;
      // A heredoc body is request text, not a path: its body rides along on
      // the redirect so a reader can recurse into it (or decline to, when it
      // is quoted or opaque). Only the closed literal shapes are kept.
      if (op === "<<" || op === "<<-") {
        const body = heredocBody(r.heredoc);
        if (body !== null) redirects.push({ op, target: body.arg, opaque: body.opaque });
        continue;
      }
      // `<<<` expands its word like an unquoted heredoc: keep it only when it
      // is a bare literal or a single-quoted word, whose text expansion
      // cannot change, and always read it as data, never as paths. The word
      // rides on `target` here, not on `heredoc`.
      if (op === "<<<") {
        const redirect = r as { target?: unknown; heredoc?: unknown };
        const word = singleQuotedWord(redirect.target ?? redirect.heredoc);
        if (word !== null) redirects.push({ op, target: { text: word, literal: true } });
        continue;
      }
      redirects.push({ op, target: wordArg(r.target) });
    }
  }
  // A socket target is a network write regardless of the command word, and a
  // redirect-only command (no words) would otherwise drop its redirect here.
  // Heredoc and here-string bodies are data, not redirect targets, so they are
  // not sockets.
  if (
    redirects.some(
      (r) => r.op !== "<<" && r.op !== "<<-" && r.op !== "<<<" && SOCKET_PATH.test(r.target.text),
    )
  ) {
    out.socket = true;
  }
  if (node.type === "DeclClause") {
    const variant = typeof node.variant === "string" ? node.variant : "declare";
    const args = (Array.isArray(node.args) ? node.args : []).map(wordArg);
    const flags = args.map((a) => a.text);
    const assigns = Array.isArray(node.assigns) ? node.assigns.length : 0;
    const dumps =
      (variant === "export" || variant === "declare" || variant === "typeset") &&
      ((assigns === 0 && args.length === 0) ||
        flags.includes("-p") ||
        (variant !== "export" && flags.includes("-x")));
    out.invocations.push({ name: variant, args, redirects, dumpsEnv: dumps });
    return;
  }
  const all = (Array.isArray(node.words) ? node.words : []).map(wordArg);
  let start = 0;
  while (start < all.length) {
    const word = all[start];
    if (word === undefined || !/^[A-Za-z_]\w*=/.test(word.text)) break;
    start++;
  }
  const words = all.slice(start);
  if (words.length === 0) return;
  const { name, args, dumpsEnv } = stripWrappers(words);
  if (name === null && !dumpsEnv) {
    out.opaque = true;
    out.invocations.push({ name: null, args, redirects, dumpsEnv: false });
    return;
  }
  if (name === "eval" || name === "source" || name === ".") out.opaque = true;
  if (name !== null && SHELLS.has(name)) {
    const c = args.findIndex((a) => a.text === "-c");
    const script = c >= 0 ? args[c + 1] : undefined;
    if (script !== undefined) {
      if (!script.literal || depth >= MAX_SHELL_DEPTH) out.opaque = true;
      else collectText(script.text, out, depth + 1);
    } else if (!args.some((a) => !a.text.startsWith("-"))) {
      // Stdin is the program when an interpreter runs with no `-c` and no
      // script-file argument: a heredoc body is the same literal request text
      // as a `-c` argument, so it is read the same way. Any other stdin — a
      // `cat <<EOF`, a data file — is data and is never read as code.
      for (const r of redirects) {
        if (r.op !== "<<" && r.op !== "<<-") continue;
        if (r.opaque === true || depth >= MAX_SHELL_DEPTH) out.opaque = true;
        else collectText(r.target.text, out, depth + 1);
      }
    }
  }
  const bareDump = (name === "printenv" || name === "set") && args.length === 0;
  out.invocations.push({ name, args, redirects, dumpsEnv: dumpsEnv || bareDump });
}

function collectText(text: string, out: Collected, depth: number): void {
  let ast: unknown;
  try {
    ast = parse(text).ast;
  } catch {
    out.parsed = false;
    out.opaque = true;
    return;
  }
  collect(ast, out, depth);
}

const GLOB = /[*?[]/;

const defaultRealpath = (p: string): string | null => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};

class PathResolver {
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

const rank: Record<PathScope, number> = { none: 0, scratch: 1, inside: 2, outside: 3, unknown: 4 };

const SCHEME_URL = /[a-z][a-z0-9+.-]*:\/\/([^/?#\s]*)/gi;

function classifyHost(authority: string): "local" | "public" | "restricted" {
  const host = authority.slice(authority.lastIndexOf("@") + 1);
  let name: string;
  if (host.startsWith("[")) {
    name = host.slice(1, host.indexOf("]") < 0 ? undefined : host.indexOf("]")).toLowerCase();
    return name === "::1" ? "local" : "restricted";
  }
  name = (host.split(":")[0] ?? "").toLowerCase();
  if (name === "") return "restricted";
  if (name === "localhost" || /^127(\.\d{1,3}){3}$/.test(name)) return "local";
  if (!name.includes(".")) return "restricted";
  if (/^[0-9a-fx.]+$/.test(name)) {
    const quad = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name);
    if (!quad) return "restricted";
    const [a, b] = [Number(quad[1]), Number(quad[2])];
    if (a === 10 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31))
      return "restricted";
    if (a === 169 && b === 254) return "restricted";
    if (a === 100 && b >= 64 && b <= 127) return "restricted";
    return "public";
  }
  if (/\.(internal|local|lan|corp|localdomain|home\.arpa)$/.test(name)) return "restricted";
  return "public";
}

function networkOf(invs: readonly Invocation[], opaque: boolean): NetworkAccess {
  let uses = false;
  let restricted = opaque;
  const hosts: string[] = [];
  for (const inv of invs) {
    const net = inv.name !== null && NETWORK_COMMANDS.has(inv.name);
    let literalUrl = false;
    for (const target of inv.redirects.map((r) => r.target)) {
      if (/^\/dev\/(tcp|udp)\//.test(target.text)) {
        uses = true;
        restricted = true;
      }
    }
    for (const arg of inv.args) {
      const urls = [...arg.text.matchAll(SCHEME_URL)];
      if (urls.length > 0) {
        uses = true;
        literalUrl = true;
        for (const m of urls) hosts.push(m[1] ?? "");
        if (!arg.literal) restricted = true;
      }
      if (net && !arg.literal) restricted = true;
    }
    if (net) {
      uses = true;
      if (!literalUrl) restricted = true;
    }
  }
  if (!uses) return opaque ? "restricted" : "none";
  const kinds = hosts.map(classifyHost);
  if (restricted || kinds.includes("restricted")) return "restricted";
  return kinds.every((k) => k === "local") ? "local" : "public";
}

/** A `git` subcommand word and the args after it. */
interface GitSubcommand {
  readonly sub: string;
  readonly rest: readonly string[];
}

function gitSubcommand(args: readonly Arg[]): GitSubcommand | null {
  for (let i = 0; i < args.length; i++) {
    const t = args[i]?.text;
    if (t === undefined) break;
    if (t === "-C" || t === "-c") {
      i++;
      continue;
    }
    if (t.startsWith("-")) continue;
    return { sub: t, rest: args.slice(i + 1).map((a) => a.text) };
  }
  return null;
}

function bindsLoopbackOnly(args: readonly Arg[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const t = args[i]?.text;
    if (t === undefined) break;
    let value: Arg | undefined;
    if (t === "--bind" || t === "-b") value = args[i + 1];
    else if (t.startsWith("--bind="))
      value = { text: t.slice(7), literal: args[i]?.literal ?? false };
    if (value) return value.literal && classifyHost(value.text) === "local";
  }
  return false;
}

const ALWAYS_SENDING = new Set([
  "scp",
  "rsync",
  "sftp",
  "nc",
  "ncat",
  "netcat",
  "socat",
  "ssh",
  "ftp",
  "telnet",
]);

/**
 * A value shaped like a token: a known secret prefix, or a long mixed
 * string (hex/base64 of 32+ chars). Length floor 20 keeps short words
 * (`status`, `latest`) out; the charset test keeps plain English out.
 */
const TOKEN_PREFIX = /^(sk-|ghp_|AKIA|eyJ)/;
const TOKEN_LONG = /\b(?:[0-9a-fA-F]{32,}|[0-9A-Za-z+/=]{32,})\b/;
function looksLikeToken(value: string): boolean {
  if (value.length < 20) return false;
  if (TOKEN_PREFIX.test(value)) return true;
  if (!TOKEN_LONG.test(value)) return false;
  // Mixed charset: letters AND digits (or +/=), so `latest/meta-data/iam`
  // style paths and plain words never match.
  return /[A-Za-z]/.test(value) && /[0-9+/=]/.test(value);
}

// A subdomain label that looks encoded: abnormally long (40+) or
// token-shaped. This is the DNS-exfiltration shape (`<data>.x.example`).
function hasEncodedSubdomain(host: string): boolean {
  return host
    .toLowerCase()
    .split(".")
    .some((label) => label.length >= 40 || looksLikeToken(label));
}

// `sendsData` also covers data riding in the URL: an expansion
// (`?k=$(cat .env)` — the arg is non-literal, so local data flows into
// the request), a token-shaped query/path value, or an encoded
// subdomain. Text-only, no file reads, no user message. This only ever
// tightens: the escalator lifts to guard, never releases.
function urlCarriesData(arg: Arg): boolean {
  const urls = [...arg.text.matchAll(SCHEME_URL)];
  if (urls.length === 0) return false;
  // Expansion follows the AST's `literal` flag — NOT a text scan for `$`:
  // single quotes suppress substitution (`'$(...)'` is inert text),
  // double quotes and bare words expand. A `/\$/` text test here
  // misread quoted inert text as data in flight (false positive).
  if (!arg.literal) return true;
  for (const m of urls) {
    const authority = m[1] ?? "";
    const host = authority.slice(authority.lastIndexOf("@") + 1).split(":")[0] ?? "";
    if (hasEncodedSubdomain(host)) return true;
    const afterHost = arg.text.slice((m.index ?? 0) + m[0].length - (m[1] ?? "").length);
    const tail = afterHost.slice(host.length);
    // Split on URL structure only (? & = / #) — token chars (`_`, `-`,
    // `.`, `=`) stay inside the value so prefix-anchored shapes match.
    for (const value of tail.split(/[?&=/#]+/)) {
      if (looksLikeToken(value)) return true;
    }
  }
  return false;
}

function sendsDataShape(name: string, args: readonly Arg[]): boolean {
  if (ALWAYS_SENDING.has(name)) return true;
  const texts = args.map((a) => a.text);
  if ((name === "docker" || name === "podman" || name === "kubectl") && texts.includes("exec"))
    return true;
  if (name !== "curl" && name !== "wget") return false;
  if (args.some(urlCarriesData)) return true;
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i];
    if (t === undefined) break;
    if (/^--(data|data-\w+|form|form-string|upload-file|post-data|post-file|json)(=|$)/.test(t))
      return true;
    if (/^-[a-zA-Z]*[dFT]$/.test(t) && !t.startsWith("--")) return true;
    if (t === "-X" || t === "--request") {
      if (/^(POST|PUT|PATCH|DELETE)$/i.test(texts[i + 1] ?? "")) return true;
    }
    if (/^(-X|--request=)(POST|PUT|PATCH|DELETE)$/i.test(t)) return true;
  }
  return false;
}

const EFFECT_RANK: Record<CommandEffect, number> = {
  read: 0,
  modify: 1,
  delete: 2,
  send_out: 3,
  unknown: 4,
};

const READ_VERBS = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "wc",
  "diff",
  "cmp",
  "file",
  "du",
  "df",
  "stat",
  "pwd",
  "echo",
  "printf",
  "cd",
  "pushd",
  "popd",
  "date",
  "uname",
  "whoami",
  "id",
  "hostname",
  "uptime",
  "free",
  "nproc",
  "ps",
  "pgrep",
  "which",
  "type",
  "true",
  "false",
  "sleep",
  "test",
  "[",
  "sort",
  "uniq",
  "cut",
  "tr",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "lsblk",
  "lscpu",
  "tree",
  "jq",
  "export",
  "printenv",
  "set",
  "env",
  "wait",
  "export",
  "declare",
  "typeset",
  "local",
  "readonly",
  "history",
  "sha256sum",
  "md5sum",
  "sha1sum",
  "column",
  "paste",
  "nl",
  "seq",
]);
const WRITE_VERBS = new Set([
  "touch",
  "mkdir",
  "cp",
  "mv",
  "ln",
  "chmod",
  "chown",
  "chgrp",
  "tee",
  "install",
  "mktemp",
]);
const DELETE_VERBS = new Set([
  "rm",
  "rmdir",
  "unlink",
  "shred",
  "truncate",
  "kill",
  "pkill",
  "killall",
  "mkfs",
  "wipefs",
]);

const GIT_READ = new Set([
  "status",
  "log",
  "diff",
  "show",
  "rev-parse",
  "ls-files",
  "blame",
  "describe",
  "shortlog",
  "grep",
  "ls-remote",
  "rev-list",
  "reflog",
]);
const GIT_WRITE = new Set([
  "add",
  "commit",
  "switch",
  "fetch",
  "merge",
  "cherry-pick",
  "revert",
  "mv",
  "init",
  "clone",
  "worktree",
]);
const GIT_DELETE = new Set(["clean", "reset", "restore", "rebase", "filter-branch", "gc", "prune"]);

function maxEffect(a: CommandEffect, b: CommandEffect): CommandEffect {
  return EFFECT_RANK[a] >= EFFECT_RANK[b] ? a : b;
}

function gitEffect(args: readonly Arg[]): CommandEffect {
  const g = gitSubcommand(args);
  if (!g) return "unknown";
  const { sub, rest } = g;
  if (GIT_READ.has(sub)) return "read";
  if (sub === "push") return "send_out";
  if (GIT_DELETE.has(sub)) return "delete";
  if (sub === "checkout") return rest.includes("--") || rest.includes(".") ? "delete" : "modify";
  if (sub === "branch") {
    if (rest.some((t) => /^(-d|-D|--delete|-m|-M)$/.test(t))) return "delete";
    return rest.some((t) => !t.startsWith("-")) ? "modify" : "read";
  }
  if (sub === "stash")
    return rest[0] === "list" || rest[0] === "show"
      ? "read"
      : rest[0] === "drop" || rest[0] === "clear"
        ? "delete"
        : "modify";
  if (sub === "tag")
    return rest.length === 0 || rest.includes("-l")
      ? "read"
      : rest.includes("-d")
        ? "delete"
        : "modify";
  if (sub === "remote")
    return rest.length === 0 || rest[0] === "-v" || rest[0] === "show" || rest[0] === "get-url"
      ? "read"
      : "modify";
  if (sub === "config")
    return rest.includes("--get") || rest.includes("--list") || rest.includes("-l")
      ? "read"
      : "modify";
  if (GIT_WRITE.has(sub)) return "modify";
  return "unknown";
}

function subcommandEffect(name: string, args: readonly Arg[]): CommandEffect {
  const t = args.filter((a) => !a.text.startsWith("-")).map((a) => a.text);
  const sub = t[0] ?? "";
  if (name === "docker" || name === "podman") {
    if (
      [
        "ps",
        "images",
        "logs",
        "inspect",
        "version",
        "info",
        "stats",
        "top",
        "port",
        "history",
      ].includes(sub)
    )
      return "read";
    if (["rm", "rmi", "prune", "kill", "stop", "system"].includes(sub)) return "delete";
    if (sub === "container" || sub === "image" || sub === "volume" || sub === "network") {
      return ["ls", "inspect", "list"].includes(t[1] ?? "")
        ? "read"
        : ["rm", "prune"].includes(t[1] ?? "")
          ? "delete"
          : "unknown";
    }
    return "unknown";
  }
  if (name === "kubectl") {
    if (["get", "describe", "logs", "top", "version", "explain"].includes(sub)) return "read";
    return sub === "delete" ? "delete" : "unknown";
  }
  if (name === "systemctl")
    return ["status", "is-active", "is-enabled", "list-units", "show"].includes(sub)
      ? "read"
      : "unknown";
  if (name === "crontab")
    return args.some((a) => a.text === "-l")
      ? "read"
      : args.some((a) => a.text === "-r")
        ? "delete"
        : "unknown";
  if (name === "npm" || name === "pnpm" || name === "yarn")
    return ["ls", "list", "view", "info", "outdated", "why"].includes(sub) ? "read" : "unknown";
  if (name === "pip" || name === "pip3")
    return ["list", "show", "freeze"].includes(sub) ? "read" : "unknown";
  if (name === "apt" || name === "apt-get" || name === "dnf" || name === "yum" || name === "brew") {
    return ["remove", "purge", "autoremove", "uninstall"].includes(sub)
      ? "delete"
      : ["list", "show", "search", "info"].includes(sub)
        ? "read"
        : "unknown";
  }
  return "unknown";
}

function verbEffect(
  name: string | null,
  args: readonly Arg[],
  redirects: readonly Redirect[],
): CommandEffect {
  if (name === null) return "unknown";
  const texts = args.map((a) => a.text);
  let effect: CommandEffect;
  if (name === "git") effect = gitEffect(args);
  else if (name === "find") {
    const exec = texts.findIndex((t) => /^-(exec|execdir|ok|okdir)$/.test(t));
    if (texts.includes("-delete") || (exec >= 0 && texts[exec + 1] === "rm")) effect = "delete";
    else if (exec >= 0 || texts.some((t) => /^-(fprint|fprintf|fls)$/.test(t))) effect = "unknown";
    else effect = "read";
  } else if (name === "sed")
    effect = texts.some((t) => /^-[a-zA-Z]*i/.test(t) || t === "--in-place") ? "modify" : "read";
  else if (name === "curl" || name === "wget") {
    effect = sendsDataShape(name, args)
      ? "send_out"
      : texts.some(
            (t) =>
              /^(-o|-O|--output|--remote-name|-[a-zA-Z]*[oO])$/.test(t) ||
              t.startsWith("--output="),
          ) || name === "wget"
        ? "modify"
        : "read";
  } else if (ALWAYS_SENDING.has(name)) effect = "send_out";
  else if (DELETE_VERBS.has(name)) effect = "delete";
  else if (WRITE_VERBS.has(name)) effect = "modify";
  else if (READ_VERBS.has(name)) effect = "read";
  else effect = subcommandEffect(name, args);
  if (
    effect !== "unknown" &&
    redirects.some(
      (r) => /^(>|>>|>\||&>|&>>|<>)$/.test(r.op) && !IGNORED_REDIRECT_TARGET.test(r.target.text),
    )
  ) {
    effect = maxEffect(effect, "modify");
  }
  return effect;
}

function pathArgs(inv: Invocation): Arg[] {
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

const IGNORED_REDIRECT_TARGET =
  /^(\/dev\/(null|stdout|stderr|stdin|tty)|\/dev\/(tcp|udp)\/.*|\d+|-)$/;

function redirectPaths(inv: Invocation): Arg[] {
  return inv.redirects
    .filter(
      (r) => !/^<<|^<<</.test(r.op) && !(r.op.endsWith("&") && /^\d+$|^-$/.test(r.target.text)),
    )
    .map((r) => r.target)
    .filter((t) => !IGNORED_REDIRECT_TARGET.test(t.text));
}

function isPersistencePath(text: string): boolean {
  if (/(^|\/)\.git\/hooks\//.test(text)) return true;
  // A husky hook is the same install as a `.git/hooks/` one, just at the path
  // the runner manages. The basename must be a hook name: writing
  // `.husky/README.md` or creating the directory installs nothing.
  if (/(^|\/)\.husky\//.test(text) && HUSKY_HOOKS.has(text.slice(text.lastIndexOf("/") + 1))) {
    return true;
  }
  if (
    /^\/etc\/(profile\.d\/|cron|systemd\/)|(^|\/)\.config\/(autostart|systemd\/user)\//.test(text)
  )
    return true;
  return STARTUP_FILES.has(text.slice(text.lastIndexOf("/") + 1));
}

/** How a runner names its project tasks. Entries are data: extending to a new ecosystem adds a row. */
interface RoutineRunner {
  readonly names: readonly string[];
  /** Task names (first positional argument, or the one after `run`) that count as routine. */
  readonly tasks: readonly string[];
  /** Accept an explicit `run` word before the task. */
  readonly allowRun?: boolean;
  /** The task body must be present in `FactsContext.declaredTasks` and free of risky verbs. */
  readonly declared?: boolean;
}

const CORE_TASKS = ["test", "build", "lint", "check", "format", "typecheck"] as const;
const ROUTINE_RUNNERS: readonly RoutineRunner[] = [
  {
    names: ["npm", "pnpm", "yarn", "bun"],
    tasks: [...CORE_TASKS, "dev", "start"],
    allowRun: true,
    declared: true,
  },
  { names: ["make", "just", "task", "ninja"], tasks: CORE_TASKS },
  { names: ["cargo"], tasks: ["test", "check", "build", "clippy", "fmt", "bench"] },
  { names: ["go"], tasks: ["test", "build", "vet"] },
  { names: ["mvn"], tasks: ["test", "verify", "compile", "package"] },
  { names: ["gradle"], tasks: ["test", "build", "check", "assemble"] },
  { names: ["dotnet"], tasks: ["test", "build"] },
  { names: ["mix"], tasks: ["test", "compile", "format"] },
  { names: ["bundle", "rake"], tasks: ["test", "spec", "rubocop"] },
];
/** Tools whose only job is to build, test, lint or format; run directly or through a launcher. */
const ROUTINE_TOOLS = new Set([
  "vite",
  "vitest",
  "jest",
  "tsc",
  "eslint",
  "oxlint",
  "prettier",
  "biome",
  "pytest",
  "ruff",
  "mypy",
  "black",
  "flake8",
  "tox",
  "nox",
  "rspec",
  "rubocop",
  "phpunit",
  "ctest",
  "cmake",
]);
const LAUNCHERS = new Set(["npx", "pnpx", "bunx", "uvx", "poetry", "pipenv"]);
const TASK_RISK =
  /\b(curl|wget|nc|ncat|ssh|scp|rsync|rm|sudo|dd|kill|publish|deploy|push|release|upload|bash|sh|zsh|node|python|python3|perl|ruby)\b/;
const SHELL_META = /[;&|<>$`(){}*?~\\\n]/;

const workspaceLocal = (args: readonly string[]) =>
  args.every((a) => !a.startsWith("/") && !a.split("/").includes(".."));

/**
 * How a command reads as a project routine:
 *
 * - `none` — not a routine command.
 * - `routine` — a recognized build/test/lint name. The name alone does not show what runs (a Makefile
 *   target, a `conftest.py`, a plugin, a config file), so it is **not** a bounded proof — the core
 *   still reads it as a run and asks.
 */
type RoutineReading = "none" | "routine";

function routineReading(
  command: string,
  invs: readonly Invocation[],
  ctx: FactsContext,
): RoutineReading {
  if (invs.length !== 1 || SHELL_META.test(command)) return "none";
  const inv = invs[0];
  if (inv?.name == null || inv.redirects.length > 0 || !inv.args.every((a) => a.literal))
    return "none";
  if (command.trim().split(/\s+/)[0] !== inv.name) return "none";
  const positional = inv.args.map((a) => a.text).filter((a) => !a.startsWith("-"));
  const allArgs = inv.args.map((a) => a.text);
  if (!workspaceLocal(allArgs.filter((a) => !a.startsWith("-")))) return "none";

  const runner = ROUTINE_RUNNERS.find((r) => r.names.includes(inv.name as string));
  if (runner) {
    const task = runner.allowRun && positional[0] === "run" ? positional[1] : positional[0];
    if (task === undefined || !runner.tasks.includes(task)) return "none";
    // A manifest runner counts as routine only when the task is declared there
    // and its body is not obviously risky; a bare-target runner (`make`,
    // `cargo`) counts by name. The declared body still does not prove what
    // runs, so the reading is never more than routine.
    if (!runner.declared) return "routine";
    const body = ctx.declaredTasks?.[task];
    return body !== undefined && !TASK_RISK.test(body) ? "routine" : "none";
  }
  const tool = LAUNCHERS.has(inv.name) ? positional[0] : inv.name;
  return tool !== undefined && ROUTINE_TOOLS.has(tool) ? "routine" : "none";
}

/**
 * Read the deterministic facts of a command text.
 *
 * @param command - The shell command text.
 * @param ctx - The working directory and (injectable) filesystem lookups.
 * @returns The facts; unparsable or opaque text yields conservative path and network facts.
 */
export function readCommandFacts(command: string, ctx: FactsContext): CommandFacts {
  const out: Collected = {
    invocations: [],
    opaque: false,
    parsed: true,
    socket: false,
    background: false,
    loop: false,
    unboundedLoop: false,
  };
  collectText(command, out, 0);
  const invs = out.invocations;
  const routine = out.opaque || !out.parsed ? "none" : routineReading(command, invs, ctx);
  const resolver = new PathResolver(ctx);
  const cdSeen = invs.some((i) => i.name === "cd" || i.name === "pushd" || i.name === "popd");

  const reads: Arg[] = [];
  const writes: Arg[] = [];
  let persistence = false;
  let grants = false;
  let recursive = false;
  let publishes = false;
  let rewritesHistory = false;
  let rawCopy = false;
  let allInterfaces = false;
  let dumpsEnvironment = false;
  let findBuildName = false;
  let sendsData = false;
  let commandEffect: CommandEffect = out.opaque || !out.parsed ? "unknown" : "read";

  for (const inv of invs) {
    const name = inv.name;
    const texts = inv.args.map((a) => a.text);
    const paths = pathArgs(inv);
    const redirected = redirectPaths(inv);
    reads.push(...paths);
    writes.push(...redirected);
    if (inv.dumpsEnv) dumpsEnvironment = true;
    if (
      name === "rm" &&
      inv.args.some((a) => /^-[a-zA-Z]*[rR]/.test(a.text) || a.text === "--recursive")
    )
      recursive = true;
    if (name === "find" && texts.includes("-delete")) recursive = true;
    if (name === "find") {
      const i = texts.findIndex((t) => t === "-name" || t === "-path");
      if (i >= 0 && BUILD_NAMES.has(texts[i + 1] ?? "")) findBuildName = true;
    }
    commandEffect = maxEffect(
      commandEffect,
      name === "dd" ? "unknown" : verbEffect(name, inv.args, inv.redirects),
    );
    if (name === "dd") rawCopy = true;
    if (name !== null && sendsDataShape(name, inv.args)) sendsData = true;
    if ((name === "npm" || name === "pnpm" || name === "yarn") && texts.includes("publish"))
      publishes = true;
    if (name === "twine" && texts.includes("upload")) publishes = true;
    if (name === "cargo" && texts.includes("publish")) publishes = true;
    if ((name === "docker" || name === "podman") && texts.includes("push")) publishes = true;
    if (name === "gh" && texts.includes("release") && texts.includes("create")) publishes = true;
    if (name === "git") {
      const g = gitSubcommand(inv.args);
      if (g) {
        if (g.sub === "commit" && g.rest.includes("--amend")) rewritesHistory = true;
        if (["rebase", "reset", "filter-branch"].includes(g.sub)) rewritesHistory = true;
        // Discarding worktree content destroys uncommitted work, which no
        // stored revision holds. `git checkout <tree-ish> -- <path>` is the
        // discard form; a bare checkout only moves HEAD.
        if (g.sub === "restore") rewritesHistory = true;
        if (g.sub === "checkout" && g.rest.includes("--")) rewritesHistory = true;
        if (g.sub === "clean" && g.rest.some((t) => /^-[a-zA-Z]*[fdx]/.test(t)))
          rewritesHistory = true;
        if (g.sub === "branch" && g.rest.some((t) => t === "-D" || t === "-d" || t === "--delete"))
          rewritesHistory = true;
      }
    }
    if (inv.args.some((a) => a.text.includes("0.0.0.0") || a.text === "::" || a.text === "[::]"))
      allInterfaces = true;
    if (texts.includes("http.server") && !bindsLoopbackOnly(inv.args)) allInterfaces = true;
    if (
      name === "crontab" &&
      (texts.length === 0 || !texts.includes("-l") || texts.includes("-r") || texts.includes("-e"))
    ) {
      persistence = true;
    }
    if (name === "systemctl" && texts.some((t) => t === "enable" || t === "link"))
      persistence = true;
    if (name === "chmod" && grantsBeyondOwner(inv.args)) grants = true;
    const reader = name !== null && READ_ONLY_COMMANDS.has(name);
    if (redirected.some((a) => isPersistencePath(a.text))) persistence = true;
    if (!reader && paths.some((a) => isPersistencePath(a.text))) persistence = true;
  }

  const all = [...reads, ...writes];
  const sensitive = all.some((a) => SENSITIVE_PATH.test(a.text));
  let scope: PathScope = out.opaque || !out.parsed ? "unknown" : "none";
  for (const a of all) {
    const s = resolver.scope(a, cdSeen);
    if (rank[s] > rank[scope]) scope = s;
  }
  // A deletion whose flags the closed shape cannot spell may reach further
  // than its paths show (`--one-file-system` changes which filesystem the
  // removal stays on): without a provable scope the row 5 block decides.
  // `only` is the single simple command the free-exit shape below also
  // reads — one declaration, two readers.
  const only = invs.length === 1 ? invs[0] : undefined;
  const removalFlagsUnknown =
    (only?.name === "rm" || only?.name === "rmdir") &&
    !only.args.every((a) => allowedRemovalWord(a.text));
  if (removalFlagsUnknown && commandEffect === "delete") scope = "unknown";
  // The free-exit shape. A build-output delete licenses skipping the operator,
  // so it is closed by construction: exactly one simple command, no chain, no
  // pipe, no redirection, no wrapper, and a delete verb from the closed list.
  // Anything else — `rm -rf $D/dist`, `mv dist src`, `xargs rm`, `echo x >
  // dist/f`, `find … -exec rm` — reads false, and false is the conservative side.
  const noRedirect = invs.every((i) => i.redirects.length === 0);
  const deletesNames =
    (only !== undefined &&
      (only.name === "rm" || only.name === "rmdir") &&
      only.args.every((a) => allowedRemovalWord(a.text))) ||
    (only?.name === "find" &&
      (only.args.some((a) => a.text === "-delete") || execDeletesBuildOutput(only.args)));
  const buildPathsOk =
    deletesNames &&
    noRedirect &&
    reads.length > 0 &&
    reads.every((a) => resolver.buildRoot(a)) &&
    !cdSeen;
  const findOk =
    deletesNames &&
    noRedirect &&
    findBuildName &&
    !cdSeen &&
    (scope === "inside" || scope === "none");

  // Variables inside a bare test (`[ -n "$API_KEY" ]`) never leave the process.
  const testOnly = invs.length > 0 && invs.every((i) => i.name === "[" || i.name === "test");
  const secretVariable =
    !testOnly &&
    /\$\{?[A-Za-z0-9_]*(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|CREDENTIAL|ACCESS_KEY)/i.test(
      command,
    );
  // A `-H`/`--header` value carrying a literal token. The value must be
  // literal text (`-H "Authorization: Bearer $TOKEN"` is an expansion —
  // the value is unreadable). Only the token-shaped literal counts; an
  // expansion in an auth-carrying header is the separate
  // `authHeaderExpansion` escalator instead.
  const headerToken =
    !out.opaque &&
    invs.some(
      (inv) =>
        (inv.name === "curl" || inv.name === "wget") &&
        inv.args.some((a, i) => {
          // One header reader for both facts: `headerField` proves the
          // field name, so the attached `-H<value>` spelling and the
          // curl-only short form come along, while `wget -H`
          // (`--span-hosts`, not a header) stays out.
          const header = headerField(inv, a, i);
          if (!header || !header.word.literal) return false;
          // Split on header structure too (`:` after the field name,
          // `=` in `Token=...`), so `X-Token:AKIA...` yields the bare
          // token — the field name is never token-shaped itself.
          return header.field.split(/[;:,\s=]+/).some((v) => looksLikeToken(v.trim()));
        }),
    );
  // An auth-carrying header whose value the record cannot show. Header name
  // matches the field name only (`Authorization`, `Proxy-Authorization`,
  // `X-Api-Key`, case-insensitive); the value must be an unreadable expansion
  // — a non-literal argument or a `--header=` word carrying an expansion — so
  // a literal token (already `headerToken`) and a single-quoted inert value
  // stay out. `Cookie` is deliberately excluded: it needs per-key evidence.
  const authHeaderExpansion =
    !out.opaque &&
    invs.some(
      (inv) =>
        (inv.name === "curl" || inv.name === "wget") &&
        inv.args.some((a, i) => {
          const header = headerField(inv, a, i);
          if (!header) return false;
          const colon = header.field.indexOf(":");
          if (colon <= 0) return false;
          const name = header.field.slice(0, colon).trim().toLowerCase();
          if (name !== "authorization" && name !== "proxy-authorization" && name !== "x-api-key") {
            return false;
          }
          // Unreadable value: the AST flags the word non-literal, and a
          // single-quoted `$VAL` stays literal (inert text).
          return !header.word.literal;
        }),
    );
  const network = networkOf(invs, out.opaque || !out.parsed);
  // A secret handed to a network command is data sent out, not data read.
  if (secretVariable && network !== "none") commandEffect = maxEffect(commandEffect, "send_out");

  return {
    parsed: out.parsed,
    pathScope: scope,
    namedBuildOutput: !out.opaque && (buildPathsOk || findOk),
    recursive,
    publishesArtifact: publishes,
    sensitivePathName: sensitive,
    publicSystemPath:
      reads.length > 0 &&
      writes.length === 0 &&
      reads.every((a) => PUBLIC_SYSTEM_PATH.test(a.text)),
    rewritesHistory,
    rawCopy,
    allInterfaces,
    network,
    dumpsEnvironment,
    installsPersistence: persistence,
    grantsBeyondOwner: grants,
    sendsData,
    commandEffect,
    secretVariable,
    headerToken,
    authHeaderExpansion,
    routineDevCommand: routine !== "none",
    socketRedirection: out.socket || invs.some((i) => i.args.some((a) => SOCKET_PATH.test(a.text))),
    unboundedSpawn: out.unboundedLoop || (out.background && out.loop),
  };
}
