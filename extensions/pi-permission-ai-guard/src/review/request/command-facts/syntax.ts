/**
 * Reading shell text into invocations: the word and heredoc readers plus the
 * walk that descends into every place a command runs. It carries the wrapper
 * vocabulary because the walk depends on it; which names are shells lives in
 * `shell-names.ts`, shared with the screen.
 */
import { parse } from "@aliou/sh";

import { SHELL_INTERPRETERS } from "#src/review/request/shell-names.ts";

import type { Arg, Collected, Invocation, Redirect } from "./types.ts";

/** Glob metacharacters: a word carrying one is not a finite literal. */
export const GLOB = /[*?[]/;

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

const MAX_SHELL_DEPTH = 3;

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
export function headerField(
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
export const SOCKET_PATH = /(^|=)\/dev\/(tcp|udp)\//;

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
  if (name !== null && SHELL_INTERPRETERS.has(name)) {
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

export function collectText(text: string, out: Collected, depth: number): void {
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
