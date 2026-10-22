/**
 * The deterministic screen: the only layer that may hard-deny. It runs after
 * the policy gate and before any model, so a hit costs no model call and is
 * never cached. A pass says nothing about safety — it only means no closed
 * rule matched.
 */
import {
  readsProgramFromStdin,
  readShellShape,
  SHELL_INTERPRETERS,
  unwrap,
  type LiteralWords,
  type PipelineWords,
  type RedirectWrite,
  type StdinSource,
} from "#src/review/request/shell-ast.ts";
import {
  executesFetchHit,
  matchCommandRule,
  matchPipelineRule,
  matchRedirectRule,
  type HardRuleHit,
} from "#src/review/screen/hard-rules.ts";

/** The screen's decision. */
export type ScreenResult =
  | { readonly kind: "deny"; readonly rule: string; readonly reason: string }
  | { readonly kind: "pass" };

const PASS: ScreenResult = { kind: "pass" };

function deny(hit: HardRuleHit): ScreenResult {
  return { kind: "deny", rule: hit.rule, reason: hit.reason };
}

/**
 * Screen a shell command text against the closed hard rules.
 *
 * @param command - The full shell command text.
 * @returns A deny with the matched rule, or pass.
 */
export function screenCommand(command: string): ScreenResult {
  const shape = readShellShape(command);
  if (shape === null) return PASS;
  const extra = programTexts(shape);
  // An `eval`/`source` that assembles its program out of a download runs
  // fetched code — the walker proved the substitution runs while the builtin
  // consumes it, in the outer text or in a carried program alike.
  if (shape.executesFetch || extra.executesFetch) return deny(executesFetchHit());
  // The walker already proved the call: a defined-and-called self-piping
  // function is the fork bomb, and a definition alone records nothing.
  if (shape.selfPipedFunctions.length > 0 || extra.selfPipedFunctions.length > 0)
    return deny({
      rule: "fork-bomb",
      reason:
        "calling a function that backgrounds a pipeline of itself replicates until the machine halts and is never allowed",
    });
  for (const words of [...shape.commands, ...extra.commands]) {
    const hit = words === null ? null : matchCommandRule(words);
    if (hit !== null) return deny(hit);
  }
  for (const write of [...shape.redirects, ...extra.redirects]) {
    const hit = matchRedirectRule(write);
    if (hit !== null) return deny(hit);
  }
  for (const stages of [...shape.pipelines, ...extra.pipelines]) {
    const hit = matchPipelineRule(stages);
    if (hit !== null) return deny(hit);
  }
  return PASS;
}

/**
 * The command and pipeline texts one level of program text yields. A subset
 * of {@link ShellShape}: inner programs never contribute stdin sources (only
 * the outer text's heredocs read as shell) or further nesting (the worklist
 * descends those itself).
 */
interface CollectedPrograms {
  readonly commands: readonly LiteralWords[];
  readonly pipelines: readonly PipelineWords[];
  readonly redirects: readonly RedirectWrite[];
  readonly selfPipedFunctions: readonly string[];
  readonly executesFetch: boolean;
}

// Whether the words name a shell interpreter (after wrappers), so its stdin
// program reads as shell.
function runsShellOnStdin(words: readonly string[]): boolean {
  const bare = unwrap(words);
  const name = bare[0]?.slice(bare[0].lastIndexOf("/") + 1) ?? "";
  return SHELL_INTERPRETERS.has(name);
}

// The program texts a command carries, read as further simple commands:
// stdin on an interpreter (heredoc bodies and script files when no
// script-file argument follows) and program arguments (`-c` strings, `eval`
// words). Only stdin that is the program is read — anything else is data
// and stays unread, so a `cat <<EOF` payload can never match a rule. Each
// level's own inline programs join the worklist, so a heredoc carrying a
// `bash -c '…'` is followed one level deeper. Every level consumes strictly
// smaller text, so the list always runs dry.
function programTexts(shape: {
  stdinSources: readonly StdinSource[];
  inlinePrograms: readonly string[];
}): CollectedPrograms {
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
    const inner = readShellShape(text);
    if (inner === null) continue;
    out.push(...inner.commands);
    pipelines.push(...inner.pipelines);
    redirects.push(...inner.redirects);
    selfPipedFunctions.push(...inner.selfPipedFunctions);
    executesFetch = executesFetch || inner.executesFetch;
    // A nested program text is followed one level deeper.
    queue.push(...inner.inlinePrograms);
  }
  return { commands: out, pipelines, redirects, selfPipedFunctions, executesFetch };
}
