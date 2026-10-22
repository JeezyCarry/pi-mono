/**
 * The deterministic screen: the only layer that may hard-deny. It runs after
 * the policy gate and before any model, so a hit costs no model call and is
 * never cached. A pass says nothing about safety — it only means no closed
 * rule matched.
 */
import { readShellShape } from "#src/review/request/shell-ast.ts";
import {
  executesFetchHit,
  forkBombHit,
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
  // The shape already runs everything the text runs: the outer commands plus
  // every carried program text, in one list each. The screen only matches.
  const shape = readShellShape(command);
  if (shape === null) return PASS;
  // An `eval`/`source` that assembles its program out of a download runs
  // fetched code — the walker proved the substitution runs while the builtin
  // consumes it, in the outer text or in a carried program alike.
  if (shape.executesFetch) return deny(executesFetchHit());
  // The walker already proved the call: a defined-and-called self-piping
  // function is the fork bomb, and a definition alone records nothing.
  if (shape.selfPipedFunctions.length > 0) return deny(forkBombHit());
  for (const words of shape.commands) {
    const hit = words === null ? null : matchCommandRule(words);
    if (hit !== null) return deny(hit);
  }
  for (const write of shape.redirects) {
    const hit = matchRedirectRule(write);
    if (hit !== null) return deny(hit);
  }
  for (const stages of shape.pipelines) {
    const hit = matchPipelineRule(stages);
    if (hit !== null) return deny(hit);
  }
  return PASS;
}
