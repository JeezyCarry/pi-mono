/**
 * The deterministic screen: the only layer that may hard-deny. It runs after
 * the policy gate and before any model, so a hit costs no model call and is
 * never cached. A pass says nothing about safety — it only means no closed
 * rule matched.
 */
import {
  readsProgramFromStdin,
  readShellShape,
  type LiteralWords,
  type StdinSource,
} from "#src/review/request/shell-ast.ts";
import {
  matchCommandRule,
  matchPipelineRule,
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
  for (const words of [...shape.commands, ...extra]) {
    const hit = words === null ? null : matchCommandRule(words);
    if (hit !== null) return deny(hit);
  }
  for (const stages of shape.pipelines) {
    const hit = matchPipelineRule(stages);
    if (hit !== null) return deny(hit);
  }
  return PASS;
}

// The program texts a command's stdin carries, read as further simple
// commands. Only stdin that is the program is read — heredoc bodies and
// script files on interpreters with no script-file argument. Anything else is
// data and stays unread, so a `cat <<EOF` payload can never match a rule.
function programTexts(shape: { stdinSources: readonly StdinSource[] }): LiteralWords[] {
  const out: LiteralWords[] = [];
  for (const source of shape.stdinSources) {
    if (!readsProgramFromStdin(source.words)) continue;
    if (source.op === "<") continue;
    if (source.text === "") continue;
    const inner = readShellShape(source.text);
    if (inner === null) continue;
    out.push(...inner.commands);
  }
  return out;
}
