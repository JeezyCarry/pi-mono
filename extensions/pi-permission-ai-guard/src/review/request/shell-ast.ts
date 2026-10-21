/**
 * Shared shell-AST reading for the deterministic layers (observed facts and
 * the hard-rule screen). One parse, one literal-word definition, and one
 * answer to "which simple commands does this text run": anything the walker
 * cannot read is reported as absent, never guessed, so a caller can only
 * ever act on what the text demonstrably says.
 */
import { parse, type Command, type SimpleCommand, type Statement, type Word } from "@aliou/sh";

/** The words of one simple command; null when any word is not a plain literal. */
export type LiteralWords = readonly string[] | null;

/** A pipeline: the literal words of each stage, in order. */
export type PipelineWords = readonly LiteralWords[];

/** A stdin redirect that can carry program text: a heredoc body or a script file. */
export interface StdinSource {
  /** The simple command's literal words, with leading wrappers still in place. */
  readonly words: readonly string[];
  /** The redirect operator: `<<`, `<<-`, `<<<`, or `<`. */
  readonly op: string;
  /** For heredocs, the body text; for `<`, the named file. */
  readonly text: string;
}

/** Interpreter names whose stdin is a program rather than data. */
export const STDIN_IS_PROGRAM: ReadonlySet<string> = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "python",
  "python3",
  "node",
  "perl",
  "ruby",
  "php",
  "sqlite3",
  "mysql",
]);

// The command's words with leading `sudo` / `command` wrappers removed.
export function unwrap(words: readonly string[]): readonly string[] {
  let i = 0;
  while (i < words.length && (words[i] === "sudo" || words[i] === "command")) i++;
  return words.slice(i);
}

/**
 * Whether this command runs its stdin as a program. The shape is mechanical:
 * after unwrapping, the name is an interpreter from the closed set, and no
 * script-file argument follows — so stdin is the program text, the same way
 * the literal argument to `-c` already is.
 *
 * @param words - The command's literal words.
 * @returns True only when stdin is the program.
 */
export function readsProgramFromStdin(words: readonly string[]): boolean {
  const bare = unwrap(words);
  const name = bare[0]?.slice(bare[0].lastIndexOf("/") + 1) ?? "";
  if (!STDIN_IS_PROGRAM.has(name)) return false;
  const args = bare.slice(1);
  if (args.includes("-c")) return false;
  return !args.some((a) => !a.startsWith("-"));
}

/** What a command text provably runs. */
export interface ShellShape {
  /** Every simple command reachable through `;`, `&&`, `||` and pipes. */
  readonly commands: readonly LiteralWords[];
  /** Every pipeline of two or more stages. */
  readonly pipelines: readonly PipelineWords[];
  /**
   * Stdin sources on literal simple commands: heredoc bodies and `< file`.
   * A source only becomes readable program text when `readsProgramFromStdin`
   * holds for its command; anything else is data and stays unread.
   */
  readonly stdinSources: readonly StdinSource[];
}

/**
 * A word's text when it is one bare literal, else null.
 *
 * @param word - The AST word to read.
 * @returns The literal text, or null for any non-bare-literal shape.
 */
export function bareLiteral(word: Word | undefined): string | null {
  if (!word || word.type !== "Word" || word.parts.length !== 1) return null;
  const part = word.parts[0];
  if (!part || part.type !== "Literal") return null;
  return part.value;
}

// A word's text when it is one bare or single-quoted literal, else null.
function quotedOrBareLiteral(word: Word | undefined): string | null {
  if (!word || word.type !== "Word" || word.parts.length !== 1) return null;
  const part = word.parts[0];
  if (!part) return null;
  if (part.type === "Literal" || part.type === "SglQuoted") return part.value;
  return null;
}

function simpleWords(cmd: SimpleCommand): LiteralWords {
  const out: string[] = [];
  for (const word of cmd.words ?? []) {
    const text = quotedOrBareLiteral(word);
    if (text === null) return null;
    out.push(text);
  }
  return out;
}

function walkStatement(
  stmt: Statement,
  commands: LiteralWords[],
  pipelines: PipelineWords[],
  stdinSources: StdinSource[],
): void {
  const cmd: Command | undefined = stmt.command;
  if (!cmd) return;
  if (cmd.type === "SimpleCommand") {
    const words = simpleWords(cmd);
    commands.push(words);
    if (words !== null) collectStdinSources(cmd, words, stdinSources);
    return;
  }
  if (cmd.type === "Logical") {
    walkStatement(cmd.left, commands, pipelines, stdinSources);
    walkStatement(cmd.right, commands, pipelines, stdinSources);
    return;
  }
  if (cmd.type === "Pipeline") {
    const stages: LiteralWords[] = [];
    for (const stage of cmd.commands) {
      const before = commands.length;
      walkStatement(stage, commands, pipelines, stdinSources);
      // A stage that is not one simple command has no readable words.
      stages.push(commands.length === before + 1 ? (commands.at(-1) ?? null) : null);
    }
    if (stages.length >= 2) pipelines.push(stages);
  }
}

// Record a stdin redirect that can carry program text: a heredoc body or a
// named script file. Only plain `Word` targets are kept; anything with a
// variable or substitution is unresolvable and stays unread.
function collectStdinSources(
  cmd: SimpleCommand,
  words: readonly string[],
  stdinSources: StdinSource[],
): void {
  for (const redirect of cmd.redirects ?? []) {
    const op: string | undefined = (redirect as { op?: string }).op;
    if (op !== "<<" && op !== "<<-" && op !== "<<<" && op !== "<") continue;
    if (op === "<") {
      const file = bareLiteral(redirect.target as Word | undefined);
      if (file !== null) stdinSources.push({ words, op, text: file });
      continue;
    }
    const body =
      (redirect as { heredoc?: Word; target?: Word }).heredoc ??
      (redirect as { target?: Word }).target;
    // `<<<` stores its word on `target`, not `heredoc`. It expands like an
    // unquoted heredoc, so it is kept only when it is provably literal: a
    // bare literal or a single-quoted word, whose text expansion cannot change.
    const raw =
      body === undefined
        ? ""
        : op === "<<<"
          ? (bareLiteral(body) ?? quotedSingleWord(body))
          : (quotedOrBareLiteral(body) ?? heredocText(body));
    stdinSources.push({ words, op, text: raw ?? "" });
  }
}

// The text of a word that is one single-quoted literal, else null.
function quotedSingleWord(body: Word): string | null {
  if (body.type !== "Word" || body.parts.length !== 1) return null;
  const part = body.parts[0];
  if (!part || part.type !== "SglQuoted") return null;
  return typeof (part as { value?: unknown }).value === "string"
    ? String((part as { value?: unknown }).value ?? "")
    : null;
}

// The body of a heredoc the deterministic layers read. The delimiter's
// quoting is not exposed, and the body word carries no quoting trace, so any
// `$` in the body is assumed to expand — and an expanded body is opaque.
// A heredoc with a variable or substitution part reads as one null: its
// expansion cannot be shown, so the whole body stays unread.
function heredocText(body: Word): string | null {
  const parts = (body as { parts?: readonly unknown[] }).parts ?? [];
  const out: string[] = [];
  for (const part of parts) {
    const p = part as { type?: string; value?: unknown };
    if (p.type !== "Literal") return null;
    const value = String(p.value ?? "");
    if (value.includes("$")) return null;
    out.push(value);
  }
  return out.join("");
}

/**
 * Read the commands a shell text runs.
 *
 * @param command - The full shell command text.
 * @returns The shape, or null when the text does not parse.
 */
export function readShellShape(command: string): ShellShape | null {
  let program;
  try {
    program = parse(command).ast;
  } catch {
    return null;
  }
  if (!program) return null;
  const commands: LiteralWords[] = [];
  const pipelines: PipelineWords[] = [];
  const stdinSources: StdinSource[] = [];
  for (const stmt of program.body)
    walkStatement(stmt as Statement, commands, pipelines, stdinSources);
  return { commands, pipelines, stdinSources };
}
