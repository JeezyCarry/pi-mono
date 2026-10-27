/**
 * The chat lane's tolerant JSON text parser: turn a model's free-text
 * reply into a `ReviewOutcome`. Tolerant by doctrine — providers wrap
 * JSON in prose, so the parser extracts the first balanced object
 * instead of demanding clean JSON, with two deliberate asymmetries:
 *
 * - A malformed _verdict-shaped_ candidate (e.g. unquoted keys, which repair cannot fix) stops the
 *   search rather than letting an unrelated later object override it — a broken deny must not flip
 *   to an allow.
 * - Non-verdict brace noise (`{var}`, markdown fragments) keeps scanning, so a model that mentions
 *   config syntax before the real verdict still parses.
 *
 * Everything else defers (fail-safe). The classifier lane never reaches
 * this module: its answers are calibrated probabilities, not text.
 */

import { MODEL_DEFER_KIND } from "#src/model/machinery-kinds.ts";
import type {
  ReviewOutcome,
  RiskLevel,
  VerdictKind,
  VerdictLean,
} from "#src/model/model-verdict.ts";
import { GENERIC_DENY_REASON, isRiskLevel } from "#src/model/model-verdict.ts";
import { extractFirstJsonObject, type JsonObjectShape } from "#src/review/json-object.ts";
import { isObjectRecord, normalizeAndRedactText, safeStringify } from "#src/utils.ts";

/**
 * The valid lean values. The `VerdictLean` type argument rejects a bad
 * member at compile time; it cannot catch an omission, so a new lean means
 * editing this line too.
 */
const VERDICT_LEANS: ReadonlySet<string> = new Set<VerdictLean>(["allow", "deny"]);

/**
 * Type guard: is `value` a valid lean?
 *
 * @param value - The string to test.
 * @returns True if `value` is a valid lean (type-narrowed).
 */
function isVerdictLean(value: string): value is VerdictLean {
  return VERDICT_LEANS.has(value);
}

/**
 * Parse the lean field off a defer verdict. Tolerant by doctrine: the
 * verdict itself parsed cleanly, so a bonus field's invalid value
 * ("maybe", "unsure", a number) degrades to neutral — a defer is never
 * invalidated by its lean.
 *
 * @param value - The raw `lean` field from the model's JSON reply.
 * @returns The lean when valid, or undefined (neutral).
 */
function parseLean(value: unknown): VerdictLean | undefined {
  return typeof value === "string" && isVerdictLean(value) ? value : undefined;
}

/** The valid verdicts, derived from {@link VerdictKind} (the single source of truth). */
const VERDICT_VALUES: ReadonlySet<string> = new Set<VerdictKind>(["allow", "deny", "defer"]);

/**
 * Normalize a model-provided explanation for the permission UI or audit log.
 *
 * @param value - Model-provided reason value.
 * @returns A safe explanation, or undefined when it has no text content.
 */
function normalizeReason(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return normalizeAndRedactText(value) || undefined;
}

/**
 * Read the risk level off a verdict object, ignoring anything unknown.
 *
 * @param value - The raw `riskLevel` field.
 * @returns The risk level when valid, else undefined.
 */
function parseRiskLevel(value: unknown): RiskLevel | undefined {
  return typeof value === "string" && isRiskLevel(value) ? value : undefined;
}

/**
 * An attempted verdict object's signature: a `verdict:` or `verdict=` key
 * (quoted or not) — how a malformed verdict attempt is told from unrelated
 * brace noise.
 */
const VERDICT_KEY_PROBE = /["']?verdict["']?\s*[:=]/i;

/**
 * The verdict lane's JSON shape: a `verdict` key marks an attempt, and two
 * objects that declare *different* verdicts contradict each other. A reply
 * that states one verdict twice (or a verdict plus unrelated JSON) keeps the
 * first.
 */
const VERDICT_SHAPE: JsonObjectShape = {
  looksLike: (fragment) => VERDICT_KEY_PROBE.test(fragment),
  consider: (found, value) => {
    if (found === null) return "adopt";
    const prior = verdictKindOf(found);
    const next = verdictKindOf(value);
    return prior !== undefined && next !== undefined && next !== prior ? "reject" : "skip";
  },
};

/**
 * The `verdict` string a parsed object declares, when it declares one.
 *
 * @param value - A parsed JSON value.
 * @returns The declared verdict kind, or undefined for anything else.
 */
function verdictKindOf(value: unknown): string | undefined {
  if (!isObjectRecord(value)) return undefined;
  const verdict = value.verdict;
  return typeof verdict === "string" ? verdict : undefined;
}

/**
 * Parse a verdict object (extracted from the model's JSON text reply) into a
 * ReviewOutcome. Anything other than a clean verdict defers (fail-safe).
 *
 * @param args - The parsed verdict object from the model's JSON reply.
 * @param latencyMs - Model call latency in milliseconds.
 * @returns A `ReviewOutcome` with the parsed verdict, or a defer outcome for invalid/missing
 *   verdicts.
 */
export function parseVerdictObject(
  args: Record<string, unknown>,
  latencyMs: number,
): ReviewOutcome {
  const verdict = args.verdict;
  const raw = safeStringify(args);
  if (typeof verdict !== "string" || !VERDICT_VALUES.has(verdict)) {
    return {
      verdict: { kind: "defer" },
      deferKind: "invalid-verdict-value",
      latencyMs,
      rawReply: raw,
    };
  }
  const riskLevel = parseRiskLevel(args.riskLevel);
  if (verdict === "defer") {
    return {
      verdict: { kind: "defer" },
      deferKind: MODEL_DEFER_KIND,
      deferReason: normalizeReason(args.reason),
      lean: parseLean(args.lean),
      latencyMs,
      riskLevel,
      rawReply: raw,
    };
  }
  if (verdict === "deny") {
    // The deny reason is model-generated text. It is structurally sanitized
    // (normalizeAndRedactText: strips zero-width chars, collapses whitespace,
    // redacts secrets) but NOT semantically filtered. It is passed back as
    // AuthorizerVerdict.reason (a "teaching reason" the invoking agent sees)
    // and persisted in the audit log. This is safe under the trust
    // assumption that the reviewer model is operator-configured and
    // trusted — it is not adversarial. If that assumption ever breaks (e.g.
    // untrusted reviewer, cross-tenant reviewer), semantic filtering would
    // be needed to prevent prompt-injection via the reason text.
    const reason = normalizeReason(args.reason) ?? GENERIC_DENY_REASON;
    return { verdict: { kind: "deny", reason }, latencyMs, riskLevel, rawReply: raw };
  }
  return { verdict: { kind: "allow" }, latencyMs, riskLevel, rawReply: raw };
}

/**
 * Parse the model's text reply. Extracts the first balanced JSON object and
 * reads it as a verdict. Returns the text as rawReply for logging.
 *
 * @param text - The model's raw text reply.
 * @param latencyMs - Model call latency in milliseconds.
 * @returns A `ReviewOutcome` parsed from the first JSON object, or a `no-json` defer outcome if
 *   none is found.
 */
export function parseTextFallback(text: string, latencyMs: number): ReviewOutcome {
  const parsed = extractFirstJsonObject(text, VERDICT_SHAPE);
  if (isObjectRecord(parsed)) {
    return parseVerdictObject(parsed, latencyMs);
  }
  return { verdict: { kind: "defer" }, deferKind: "no-json", latencyMs, rawReply: text };
}
