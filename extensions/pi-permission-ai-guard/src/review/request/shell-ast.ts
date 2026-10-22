/**
 * Shared shell-AST reading for the deterministic layers (observed facts and
 * the hard-rule screen). One parse, one literal-word definition, and one
 * answer to "which simple commands does this text run": anything the walker
 * cannot read is reported as absent, never guessed, so a caller can only
 * ever act on what the text demonstrably says.
 *
 * The walk descends everywhere a command actually runs — compound commands
 * (`{ …; }`, `( … )`, `if`/`while`/`for`/`case` bodies, function bodies at
 * their call site), command and process substitutions, and the tail of a
 * transparent wrapper (`sudo -u bob`, `env FOO=1`, `nice -n 5`) — and it
 * re-reads the program texts a command carries (an interpreter's stdin or
 * heredoc, a `-c` string, the words `eval` assembles), so one shape answers
 * for the whole text. It never descends into text that is data: a quoted
 * string, a heredoc body on a command that reads it as data, an assignment's
 * value that nothing executes, an alias body (which only expands in a shell
 * that enables expansion before reading the line). A construct the walker
 * does not model contributes nothing, so the conservative reading stays
 * "unproven", never "safe".
 */
import {
  parse,
  type ArithExpr,
  type Assignment,
  type CaseItem,
  type Command,
  type Redirect,
  type SimpleCommand,
  type Statement,
  type TestExpr,
  type Word,
  type WordPart,
} from "@aliou/sh";

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

/** A redirect that writes to a literal target. */
export interface RedirectWrite {
  /** The simple command's literal words, with leading wrappers still in place. */
  readonly words: readonly string[];
  /** The redirect operator: `>`, `>>`, `>|`, `&>`, or `&>>`. */
  readonly op: string;
  /** The literal target path. */
  readonly target: string;
}

/**
 * Fetch commands whose stdout is program-shaped: piping it into a shell
 * or interpreter, or evaluating/sourcing its substitution, runs remote code.
 */
export const DOWNLOADERS: ReadonlySet<string> = new Set(["curl", "wget"]);

export function baseName(word: string): string {
  return word.slice(word.lastIndexOf("/") + 1);
}

/** Builtins that execute the program their arguments assemble. */
const EXEC_BUILTINS: ReadonlySet<string> = new Set(["eval", "source", "."]);

/** Shell interpreter names: the only ones whose `-c` strings run as shell. */
export const SHELL_INTERPRETERS: ReadonlySet<string> = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
]);

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

// Wrappers that run the words after them: the name is not the command, the
// tail is. Each entry's option surface is a closed set, so an option taking a
// value consumes it instead of being mistaken for the command name.
const TRANSPARENT: ReadonlySet<string> = new Set([
  "sudo",
  "command",
  "exec",
  "nohup",
  "time",
  "builtin",
  "nice",
  "stdbuf",
  "env",
  "noglob",
  // Runners that execute their remaining words: `watch` repeats the command,
  // `xargs` appends input to it, `npx`/`bunx` run the named package's binary.
  // Either way the tail is what runs.
  "watch",
  "xargs",
  "npx",
  "bunx",
  // `timeout DURATION CMD…` runs its tail after the duration.
  "timeout",
]);

// Options that consume the following word as their value, per wrapper.
const WRAPPER_VALUE_OPTS: Readonly<Record<string, ReadonlySet<string>>> = {
  // Only options that ALWAYS take a value. A boolean listed here would eat the
  // command name (`watch -d rm …`), and a value option left out would leave its
  // value as the head — both read the wrong word as the program, so each entry
  // is checked against the tool's own manual.
  sudo: new Set(["-u", "-g", "-p", "-C", "-h", "-r", "-t", "-U", "-T", "-D", "-R", "-a", "-c"]),
  exec: new Set(["-a"]),
  nice: new Set(["-n"]),
  stdbuf: new Set(["-i", "-o", "-e"]),
  env: new Set(["-u", "-C", "-S"]),
  time: new Set(["-f", "-o"]),
  watch: new Set(["-n"]),
  xargs: new Set(["-I", "-n", "-P", "-L", "-E", "-s", "-a", "-d"]),
  npx: new Set(["-p", "--package"]),
  bunx: new Set(["-p", "--package"]),
  timeout: new Set(["-s", "--signal", "-k", "--kill-after"]),
};

function skipWrapperOptions(
  words: readonly string[],
  start: number,
  valueOpts: ReadonlySet<string> | undefined,
): number {
  let i = start;
  while (i < words.length) {
    const word = words[i];
    if (word === undefined) break;
    if (word === "--") return i + 1;
    if (!word.startsWith("-") || word === "-") break;
    if (valueOpts?.has(word) === true) {
      i += 2;
      continue;
    }
    i += 1;
  }
  return i;
}

/**
 * The command's words with leading wrappers (`sudo`, `command`, `env`, …)
 * removed, so the first returned word names the program that actually runs.
 * `command -v`/`-V` only looks a name up and runs nothing, so it unwraps to
 * nothing.
 *
 * @param words - The command's literal words.
 * @returns The words after the wrappers.
 */
// A wrapper asked to print help or its version runs nothing after it.
const TERMINAL_FLAGS: ReadonlySet<string> = new Set(["--help", "--version", "-V"]);

export function unwrap(words: readonly string[]): readonly string[] {
  let i = 0;
  while (i < words.length) {
    const head = words[i];
    if (head === undefined) break;
    if (!TRANSPARENT.has(head)) break;
    if (head === "command" && (words[i + 1] === "-v" || words[i + 1] === "-V")) return [];
    if (TERMINAL_FLAGS.has(words[i + 1] ?? "")) return [];
    i += 1;
    i = skipWrapperOptions(words, i, WRAPPER_VALUE_OPTS[head]);
    // `timeout` takes a bare duration before the command (`timeout 10 rm …`).
    // A non-duration there is the command itself, so only a duration is eaten:
    // `timeout rm …` is a usage error that runs nothing either way.
    if (head === "timeout" && /^\d+(\.\d+)?(s|m|h|d)?$/.test(words[i] ?? "")) i += 1;
    // `env` also accepts leading NAME=value assignments.
    if (head === "env")
      while (words[i]?.includes("=") === true && words[i]?.startsWith("-") !== true) i += 1;
  }
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
  /** Every simple command the text runs, nested program texts included. */
  readonly commands: readonly LiteralWords[];
  /** Every pipeline of two or more stages, nested program texts included. */
  readonly pipelines: readonly PipelineWords[];
  /** Writes to a literal target, nested program texts included. */
  readonly redirects: readonly RedirectWrite[];
  /**
   * Called functions whose body pipes the function into itself in the
   * background — the fork bomb's shape, independent of the name chosen. A
   * definition alone records nothing: it denies only where the text calls it.
   */
  readonly selfPipedFunctions: readonly string[];
  /** An `eval`/`source` in the text assembles its program out of a download. */
  readonly executesFetch: boolean;
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

/**
 * A word's text when nothing in it can expand: bare or single-quoted
 * literals, and double-quoted runs whose parts are all plain literals. Any
 * expansion, substitution or glob makes the text unprovable and yields null.
 *
 * @param word - The AST word to read.
 * @returns The static text, or null.
 */
function staticText(word: Word): string | null {
  const out: string[] = [];
  for (const part of word.parts) {
    if (part.type === "Literal" || part.type === "SglQuoted") {
      if (part.value.includes("$")) return null;
      out.push(part.value);
      continue;
    }
    if (part.type === "DblQuoted") {
      for (const inner of part.parts) {
        if (inner.type !== "Literal" || inner.value.includes("$")) return null;
        out.push(inner.value);
      }
      continue;
    }
    return null;
  }
  return out.join("");
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

/** A walked text: the {@link ShellShape} plus the program texts it carries. */
interface WalkedText extends ShellShape {
  readonly stdinSources: readonly StdinSource[];
  readonly inlinePrograms: readonly string[];
}

/** The collector every walk step appends to. */
interface Walked extends WalkedText {
  readonly commands: LiteralWords[];
  readonly pipelines: PipelineWords[];
  readonly stdinSources: StdinSource[];
  readonly redirects: RedirectWrite[];
  readonly selfPipedFunctions: string[];
  readonly inlinePrograms: string[];
  /** An `eval`/`source` in the text assembles its program out of a download. */
  executesFetch: boolean;
  /**
   * Definitions in force at the current point in the text, and the ones being
   * expanded right now. A body joins the action only at a call site, so a
   * definition on its own never reads as executed — and a redefinition takes
   * effect for the calls that follow it, as the shell resolves it.
   */
  readonly defined: Map<string, readonly Statement[]>;
  readonly expanding: Set<string>;
}

function walkStatement(stmt: Statement, out: Walked): void {
  walkCommand(stmt.command, out);
}

// Walk every statement in a list (a compound command's body), in order.
function walkBody(body: readonly Statement[] | undefined, out: Walked): void {
  for (const stmt of body ?? []) walkStatement(stmt, out);
}

// Descend into the command subcommands a word runs.
function walkWordParts(parts: readonly WordPart[] | undefined, out: Walked): void {
  for (const part of parts ?? []) {
    if (part.type === "CmdSubst" || part.type === "ProcSubst") {
      walkBody(part.stmts, out);
      continue;
    }
    if (part.type === "DblQuoted") {
      walkWordParts(part.parts, out);
      continue;
    }
    // `${x:-$(…)}`, `${a[$(…)]}`, `${s/$(…)/…}`: the expansion's own words run
    // their substitutions while the shell builds the value.
    if (part.type === "ParamExp") {
      walkWordParts(part.index?.parts, out);
      walkWordParts(part.slice?.offset.parts, out);
      walkWordParts(part.slice?.length?.parts, out);
      walkWordParts(part.replace?.orig.parts, out);
      walkWordParts(part.replace?.with?.parts, out);
      walkWordParts(part.exp?.word?.parts, out);
      continue;
    }
    if (part.type === "ArithExp") walkArith(part.x, out);
  }
}

// An arithmetic expression's variables may be substitutions.
function walkArith(expr: ArithExpr | undefined, out: Walked): void {
  if (expr === undefined) return;
  switch (expr.type) {
    case "ParamExp":
      return walkWordParts([expr], out);
    case "BinaryArithm":
      walkArith(expr.x, out);
      walkArith(expr.y, out);
      return;
    case "UnaryArithm":
    case "ParenArithm":
      walkArith(expr.x, out);
      return;
    default:
      return;
  }
}

// A `[[ … ]]` test's operands are words, and a word can hold a substitution.
function walkTest(expr: TestExpr | undefined, out: Walked): void {
  if (expr === undefined) return;
  switch (expr.type) {
    case "BinaryTest":
      walkTest(expr.x, out);
      walkTest(expr.y, out);
      return;
    case "UnaryTest":
    case "ParenTest":
      walkTest(expr.x, out);
      return;
    case "Word":
      walkWordParts(expr.parts, out);
      return;
    default:
      return;
  }
}

// The words a statement runs, when it is one literal simple command.
function leadingWords(stmt: Statement): LiteralWords {
  const cmd = stmt.command;
  if (cmd?.type !== "SimpleCommand") return null;
  const words = simpleWords(cmd);
  return words === null ? null : unwrap(words);
}

// The fork bomb's shape: an all-self pipeline with a backgrounded ancestor.
// `&` backgrounds a whole list, so the flag threads down through every
// wrapper — but it must sit on THIS pipeline's ancestor chain. A background
// elsewhere (`f(){ sleep 1 & f|f; }; f`) does not double, and a foreground
// self-pipe (`f(){ f|f; }; f`) doubles only serially; both stay readable for
// the model lane instead of firing here.
function pipelineRunsSelf(cmd: Command, name: string): boolean {
  if (cmd.type !== "Pipeline") return false;
  const heads = cmd.commands.map(leadingWords);
  return heads.length >= 2 && heads.every((words: LiteralWords) => words?.[0] === name);
}

function stmtsRunBomb(
  stmts: readonly Statement[] | undefined,
  name: string,
  backgrounded: boolean,
): boolean {
  for (const stmt of stmts ?? []) {
    if (cmdRunsBomb(stmt.command, name, backgrounded || stmt.background === true)) return true;
  }
  return false;
}

function cmdRunsBomb(cmd: Command, name: string, backgrounded: boolean): boolean {
  if (cmd.type === "Pipeline") return pipelineRunsSelf(cmd, name) && backgrounded;
  if (cmd.type === "Logical") {
    return (
      cmdRunsBomb(cmd.left.command, name, backgrounded) ||
      cmdRunsBomb(cmd.right.command, name, backgrounded)
    );
  }
  if (cmd.type === "TimeClause") return stmtsRunBomb([cmd.command], name, backgrounded);
  if (cmd.type === "CoprocClause") return stmtsRunBomb([cmd.body], name, backgrounded);
  // Body lists: blocks, subshells, `if`/`while`/`for`/`case`, functions.
  return nestedBodies(cmd).some((list) => stmtsRunBomb(list, name, backgrounded));
}

function isSelfPiped(name: string, body: readonly Statement[]): boolean {
  return stmtsRunBomb(body, name, false);
}

// The statement lists a compound command carries, for shape-only scans.
function nestedBodies(cmd: Command): readonly (readonly Statement[] | undefined)[] {
  switch (cmd.type) {
    case "Subshell":
    case "Block":
    case "FunctionDecl":
      return [cmd.body];
    case "CStyleLoop":
      return [cmd.body];
    case "IfClause":
      return [cmd.cond, cmd.then, cmd.else];
    case "WhileClause":
      return [cmd.cond, cmd.body];
    case "ForClause":
    case "SelectClause":
      return [cmd.body];
    case "CaseClause":
      return cmd.items.map((item: CaseItem) => item.body);
    default:
      return [];
  }
}

// Descend into an assignment's value: `FOO=$(…)` runs before the command does.
function walkAssignment(assign: Assignment, out: Walked): void {
  walkWordParts(assign.value?.parts, out);
  for (const elem of assign.array?.elems ?? []) {
    walkWordParts(elem.index?.parts, out);
    walkWordParts(elem.value?.parts, out);
  }
}

// The `time` keyword's own flags, which the parser folds into the timed
// command's words. They must come off before the head is read as the program.
const TIME_FLAGS: ReadonlySet<string> = new Set(["-p", "-v", "-a"]);
const TIME_OUTPUT_FLAGS: ReadonlySet<string> = new Set(["-o", "--output"]);

function stripTimeFlags(words: readonly Word[] | undefined): readonly Word[] | undefined {
  if (words === undefined) return undefined;
  let i = 0;
  while (i < words.length) {
    const text = bareLiteral(words[i]);
    if (text === null) break;
    if (TIME_FLAGS.has(text) || text.startsWith("--output=")) {
      i += 1;
      continue;
    }
    if (TIME_OUTPUT_FLAGS.has(text)) {
      i += 2;
      continue;
    }
    break;
  }
  return words.slice(i);
}

function walkSimpleCommand(cmd: SimpleCommand, out: Walked): void {
  const words = simpleWords(cmd);
  out.commands.push(words);
  if (words !== null) {
    collectStdinSources(cmd.redirects, words, out.stdinSources);
    collectRedirectWrites(cmd.redirects, words, out.redirects);
  }
  // The `-c` / `eval` program text is read through the static form, so a
  // double-quoted argument counts when nothing in it expands — and a partly
  // dynamic command still yields its provable leading words.
  const statics = (cmd.words ?? []).map(staticText);
  const staticWords: string[] = [];
  for (const text of statics) {
    if (text === null) break;
    staticWords.push(text);
  }
  if (staticWords.length === statics.length) {
    collectInlineProgram(staticWords, out.inlinePrograms);
  }
  // Substitutions this command carries run no matter where they sit, so every
  // command they add is recorded against this one before the checks below.
  const before = out.commands.length;
  for (const word of cmd.words ?? []) walkWordParts(word.parts, out);
  // A call to a function defined earlier in the same text runs that body, so
  // the body is part of the action. The name is marked while expanding, which
  // stops a recursive definition from looping.
  // An `alias` body is deliberately not read: a real shell expands an alias
  // only when the definition precedes the line being read (a same-line
  // `alias x='…'; x` never fires) and only with expansion enabled, neither of
  // which the text can prove. Such a call reads as an unproven command and goes
  // to the model lane.
  if (words !== null) {
    const head = unwrap(words)[0];
    const body = head === undefined ? undefined : out.defined.get(head);
    if (body !== undefined && head !== undefined && !out.expanding.has(head)) {
      if (isSelfPiped(head, body)) out.selfPipedFunctions.push(head);
      out.expanding.add(head);
      for (const stmt of body) walkStatement(stmt, out);
      out.expanding.delete(head);
    }
  }
  // Prefix assignments run their substitutions before the command does.
  for (const assign of cmd.assignments ?? []) walkAssignment(assign, out);
  for (const redirect of cmd.redirects ?? []) walkWordParts(redirect.target?.parts, out);
  // `eval "$(curl …)"`, `source <(curl …)` and `bash <(curl …)` all run code the
  // substitution fetched: the builtin or the shell consumes the fetch's output
  // as its program. A literal script operand means the shell runs that file
  // instead, so `bash run.sh <(curl …)` passes the fetch as an argument.
  const firstWord = cmd.words?.[0];
  const execName = words?.[0] ?? (firstWord === undefined ? null : staticText(firstWord));
  if (execName !== null && execName !== undefined) {
    const name = baseName(execName);
    const literalOperand = (cmd.words ?? []).some((word: Word, index: number) => {
      if (index === 0) return false;
      const text = staticText(word);
      return text !== null && !text.startsWith("-");
    });
    if (EXEC_BUILTINS.has(name) || (SHELL_INTERPRETERS.has(name) && !literalOperand)) {
      const fetched = out.commands
        .slice(before)
        .some((added) => added !== null && DOWNLOADERS.has(baseName(unwrap(added)[0] ?? "")));
      if (fetched) out.executesFetch = true;
    }
  }
}

function walkCommand(cmd: Command, out: Walked): void {
  switch (cmd.type) {
    case "SimpleCommand":
      walkSimpleCommand(cmd, out);
      return;
    case "Logical":
      walkStatement(cmd.left, out);
      walkStatement(cmd.right, out);
      return;
    case "Pipeline": {
      const stages: LiteralWords[] = [];
      for (const stage of cmd.commands) {
        const before = out.commands.length;
        walkStatement(stage, out);
        // A stage that is not one simple command has no readable words.
        stages.push(out.commands.length === before + 1 ? (out.commands.at(-1) ?? null) : null);
      }
      if (stages.length >= 2) out.pipelines.push(stages);
      return;
    }
    case "Subshell":
    case "Block":
      walkBody(cmd.body, out);
      return;
    case "FunctionDecl":
      // A definition executes nothing on its own: its body is only read once
      // the same text is proven to call it, at that call site.
      out.defined.set(cmd.name, cmd.body);
      return;
    case "IfClause":
      walkBody(cmd.cond, out);
      walkBody(cmd.then, out);
      walkBody(cmd.else, out);
      return;
    case "WhileClause":
      walkBody(cmd.cond, out);
      walkBody(cmd.body, out);
      return;
    case "ForClause":
    case "SelectClause": {
      // The item list is data; the body runs.
      for (const item of cmd.items ?? []) walkWordParts(item.parts, out);
      walkBody(cmd.body, out);
      return;
    }
    case "CStyleLoop":
      walkBody(cmd.body, out);
      return;
    case "CaseClause":
      walkWordParts(cmd.word.parts, out);
      for (const item of cmd.items) walkBody(item.body, out);
      return;
    case "TimeClause": {
      const inner = cmd.command.command;
      // `time -p rm …` parses as TimeClause(SimpleCommand(["-p","rm",…])).
      if (inner.type === "SimpleCommand") {
        walkSimpleCommand({ ...inner, words: stripTimeFlags(inner.words) }, out);
        return;
      }
      walkStatement(cmd.command, out);
      return;
    }
    case "CoprocClause":
      walkStatement(cmd.body, out);
      return;
    case "DeclClause":
      for (const arg of cmd.args ?? []) walkWordParts(arg.parts, out);
      for (const assign of cmd.assigns ?? []) walkAssignment(assign, out);
      return;
    case "LetClause":
      // `let x=$(…)` evaluates its words' substitutions.
      for (const word of cmd.exprs) walkWordParts(word.parts, out);
      return;
    case "TestClause":
      walkTest(cmd.x, out);
      return;
    case "ArithCmd":
      walkArith(cmd.x, out);
      return;
    default:
      return;
  }
}

// Record program text carried as an argument: an interpreter's `-c` string
// runs as a program, and `eval` runs the words it assembles. Both are read
// as further shell text by the callers, so a wrapped `bash -c 'rm -rf /'`
// cannot hide behind its quotes.
function collectInlineProgram(words: readonly string[], out: string[]): void {
  const bare = unwrap(words);
  const name = bare[0]?.slice(bare[0].lastIndexOf("/") + 1) ?? "";
  if (name === "eval") {
    if (bare.length > 1) out.push(bare.slice(1).join(" "));
    return;
  }
  // `npx -c '…'` runs its string in a shell; after the runner is
  // unwrapped the flag is all that is left of the head.
  if (name === "-c" || name === "--call") {
    if (bare[1] !== undefined) out.push(bare[1]);
    return;
  }
  // Only shells run `-c` strings as shell: a `python3 -c '…'` body is
  // Python, and reading it as shell would misjudge foreign code.
  if (!SHELL_INTERPRETERS.has(name)) return;
  const at = bare.indexOf("-c");
  if (at >= 0 && bare[at + 1] !== undefined) out.push(bare[at + 1]);
}

// Record a stdin redirect that can carry program text: a heredoc body or a
// named script file. Only plain `Word` targets are kept; anything with a
// variable or substitution is unresolvable and stays unread.
function collectStdinSources(
  redirects: readonly Redirect[] | undefined,
  words: readonly string[],
  stdinSources: StdinSource[],
): void {
  for (const redirect of redirects ?? []) {
    const op = redirect.op;
    if (op !== "<<" && op !== "<<-" && op !== "<<<" && op !== "<") continue;
    if (op === "<") {
      const file = bareLiteral(redirect.target);
      if (file !== null) stdinSources.push({ words, op, text: file });
      continue;
    }
    const body = redirect.heredoc ?? redirect.target;
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

// Record writes to a literal target: the redirect's operator plus the path.
// A redirect whose target is not a bare literal names nothing provable, so it
// is left out rather than guessed.
function collectRedirectWrites(
  redirects: readonly Redirect[] | undefined,
  words: readonly string[],
  out: RedirectWrite[],
): void {
  for (const redirect of redirects ?? []) {
    const op = redirect.op;
    if (op !== ">" && op !== ">>" && op !== ">|" && op !== "&>" && op !== "&>>") continue;
    const target = bareLiteral(redirect.target);
    if (target !== null) out.push({ words, op, target });
  }
}

// The text of a word that is one single-quoted literal, else null.
function quotedSingleWord(body: Word): string | null {
  if (body.type !== "Word" || body.parts.length !== 1) return null;
  const part = body.parts[0];
  if (!part || part.type !== "SglQuoted") return null;
  return part.value;
}

// The body of a heredoc the deterministic layers read. The delimiter's
// quoting is not exposed, and the body word carries no quoting trace, so any
// `$` in the body is assumed to expand — and an expanded body is opaque.
// A heredoc with a variable or substitution part reads as one null: its
// expansion cannot be shown, so the whole body stays unread.
function heredocText(body: Word): string | null {
  const out: string[] = [];
  for (const part of body.parts) {
    if (part.type !== "Literal") return null;
    const value = part.value;
    if (value.includes("$")) return null;
    out.push(value);
  }
  return out.join("");
}

// Whether the words name a shell interpreter (after wrappers), so its stdin
// program reads as shell.
function runsShellOnStdin(words: readonly string[]): boolean {
  const bare = unwrap(words);
  return SHELL_INTERPRETERS.has(baseName(bare[0] ?? ""));
}

/**
 * The program texts a shape carries, read as further simple commands: stdin
 * on an interpreter (heredoc bodies and script files when no script-file
 * argument follows) and program arguments (`-c` strings, `eval` words). Only
 * stdin that is the program is read — anything else is data and stays unread,
 * so a `cat <<EOF` payload can never match a rule. Each level's own inline
 * programs join the worklist, so a heredoc carrying a `bash -c '…'` is
 * followed one level deeper. Every level consumes strictly smaller text, so
 * the list always runs dry.
 *
 * @param shape - The outer shape's stdin sources and inline programs.
 * @returns The collected inner commands, pipelines, redirects, and flags.
 */
function collectProgramTexts(shape: WalkedText): ShellShape {
  const out: LiteralWords[] = [];
  const pipelines: PipelineWords[] = [];
  const redirects: RedirectWrite[] = [];
  const selfPipedFunctions: string[] = [];
  let executesFetch = false;
  const queue: string[] = [];
  for (const source of shape.stdinSources) {
    if (!readsProgramFromStdin(source.words)) continue;
    // Only a shell runs its stdin as shell: a `python3 <<EOF` body is
    // Python, and reading it as shell would misjudge foreign code.
    if (!runsShellOnStdin(source.words)) continue;
    if (source.op === "<") continue;
    if (source.text !== "") queue.push(source.text);
  }
  queue.push(...shape.inlinePrograms);
  for (const text of queue) {
    const inner = walkText(text);
    if (inner === null) continue;
    out.push(...inner.commands);
    pipelines.push(...inner.pipelines);
    redirects.push(...inner.redirects);
    selfPipedFunctions.push(...inner.selfPipedFunctions);
    executesFetch = executesFetch || inner.executesFetch;
    // A nested program text is followed one level deeper.
    queue.push(...inner.inlinePrograms);
  }
  return {
    commands: [...shape.commands, ...out],
    pipelines: [...shape.pipelines, ...pipelines],
    redirects: [...shape.redirects, ...redirects],
    selfPipedFunctions: [...shape.selfPipedFunctions, ...selfPipedFunctions],
    executesFetch: executesFetch || shape.executesFetch,
  };
}

/**
 * Read everything a shell text runs: the outer commands plus every carried
 * program text, in one list each. A caller that needs less is holding too
 * much; the intermediates stay inside.
 *
 * @param command - The full shell command text.
 * @returns The shape, or null when the text does not parse.
 */
export function readShellShape(command: string): ShellShape | null {
  const walked = walkText(command);
  return walked === null ? null : collectProgramTexts(walked);
}

/**
 * The walk itself: the text's own commands plus the program texts it carries,
 * unexpanded. Internal — {@link readShellShape} is the interface, and a caller
 * that stopped here would miss everything a carried program runs.
 *
 * @param command - The shell command text.
 * @returns The walked shape, or null when the text does not parse.
 */
function walkText(command: string): WalkedText | null {
  let program;
  try {
    program = parse(command).ast;
  } catch {
    return null;
  }
  if (!program) return null;
  const out: Walked = {
    commands: [],
    pipelines: [],
    stdinSources: [],
    redirects: [],
    selfPipedFunctions: [],
    inlinePrograms: [],
    executesFetch: false,
    defined: new Map(),
    expanding: new Set(),
  };
  for (const stmt of program.body) walkStatement(stmt as Statement, out);
  return out;
}
