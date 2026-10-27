/**
 * The chat lane's structured-claim contract and parser.
 *
 * Under the shared core the chat model stops emitting a verdict and instead
 * reports which {@link PolicyConcept}s it can see, with a presence and a
 * confidence. Those claims may only tighten the deterministic base tier; the
 * core rules. This module turns the model's JSON into {@link ModelClaim}s.
 *
 * Parse discipline: a reply is usable only if EVERY entry is valid. A dropped
 * entry makes the whole reply a parse failure, so a broken reply defers instead
 * of silently shrinking to a weaker claim set.
 */

import type { RiskLevel } from "#src/model/model-verdict.ts";
import { isRiskLevel } from "#src/model/model-verdict.ts";
import { extractFirstJsonObject, type JsonObjectShape } from "#src/review/json-object.ts";
import { isObjectRecord, normalizeAndRedactText } from "#src/utils.ts";

import { isPresence, POLICY_CONCEPTS, type ModelClaim, type PolicyConcept } from "./concepts.ts";

const CONCEPTS = new Set<string>(POLICY_CONCEPTS);
/** The key that marks a claims object. */
const CLAIMS_KEY = "evidence";

/**
 * Decode a string token's escapes, so an escaped key (`evi\u0064ence`) still
 * reads as the key it names.
 *
 * @param raw - The token's raw text, without its quotes.
 * @returns The decoded token. When JSON refuses an escape, its C-style `\xHH`
 *   spelling is decoded instead, so a key escaped the way JSON cannot spell it
 *   is still read rather than skipped.
 */
function decodeToken(raw: string): string {
  if (!raw.includes("\\")) return raw;
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw.replace(/\\x([0-9a-fA-F]{2})/g, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
  }
}

/**
 * Characters an encoder could slip into a key to hide it: whitespace of any
 * kind, the zero-width family, and the C0 controls. They are removed before the
 * key is compared, so a padded or zero-width-obfuscated `evidence` is still
 * read as the key.
 */
// the C0 range and DEL are the point: an encoder can hide a key inside them
// oxlint-disable-next-line no-control-regex
const INVISIBLE = /[\s\u200b-\u200d\u0000-\u001f\u007f]/g;

// The one bounded key-recognition rule, shared by the parseable selector and
// the malformed-fragment probe: a written key names the claims key when its
// letters are `evidence`, ignoring case, escapes, and invisible characters.
function isClaimsKey(name: string): boolean {
  return name.replace(INVISIBLE, "").toLowerCase() === CLAIMS_KEY;
}

// Is this unparseable fragment an attempted claims object?
//
// The fragment cannot be parsed, so the key is read structurally: a token
// outside a string counts when it spells `evidence` (escapes decoded) and
// either sits at a key position — just after `{` or `,` — or is followed by
// `:`, the way a key is. So a value that merely spells the word
// (`{"reason":"x, evidence"`) is not an attempt, `{"reason":"x" "evidence":1`
// still is even though its member comma is missing, and a longer key
// (`evidenceMore`) is a different key.
//
// Escapes are decoded, invisible characters are dropped, and the comparison is
// case-insensitive, so `{"evi\u0064ence":1`, `{"evi\x64ence":1`, `{" evidence":1`
// and `{"EVIDENCE":1` all read as attempts.
//
// A colon is not required at a key position, because a cut-off `{"evidence"`
// must stop the search rather than be skipped for a later object. An
// unterminated string leaves the rest unreadable, so the fragment fails closed.
//
// Recognition boundary: the shared `isClaimsKey` rule reads only the ASCII
// letters `evidence`. A fragment whose key letters are not ASCII — a Unicode
// case fold (`evİdence`), a fullwidth or homoglyph spelling — reads as brace
// noise, as does one that is comma-less and closed before its colon
// (`{"reason":"x" "evidence"}`), and a later object may then decide. The probe
// reasons over unparseable text instead of parsing it, so it cannot tell every
// broken key from ordinary text.
function looksLikeClaimsAttempt(fragment: string): boolean {
  // The fragment starts at an opening brace.
  let atKeyPosition = true;
  let i = 0;
  while (i < fragment.length) {
    const ch = fragment.charAt(i);
    let token: string;
    if (ch === '"' || ch === "'") {
      const start = i + 1;
      let escaped = false;
      i++;
      for (; i < fragment.length; i++) {
        const c = fragment.charAt(i);
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === ch) break;
      }
      if (i >= fragment.length) return true;
      token = decodeToken(fragment.slice(start, i));
      i++;
    } else if (/[\w$]/.test(ch)) {
      const start = i;
      while (i < fragment.length && /[\w$]/.test(fragment.charAt(i))) i++;
      token = fragment.slice(start, i);
    } else {
      if (!/\s/.test(ch)) atKeyPosition = ch === "{" || ch === ",";
      i++;
      continue;
    }
    if (isClaimsKey(token) && (atKeyPosition || /^\s*:/.test(fragment.slice(i)))) return true;
    atKeyPosition = false;
  }
  return false;
}

/**
 * The claims lane's JSON shape. Recognition is tolerant and reading is exact: a
 * parsed object belongs to this lane when one of its keys is recognized (a
 * wrong-typed value is still this object, so it is selected and then rejected,
 * never skipped), but only a lone exact `evidence` key is read as data. A
 * near-miss key, a key beside another recognized key, a second claims object,
 * and a claims-shaped fragment that cannot parse all reject the reply — it must
 * defer rather than shrink to a weaker claim set.
 */
const CLAIMS_SHAPE: JsonObjectShape = {
  looksLike: looksLikeClaimsAttempt,
  consider: (found, value) => {
    if (!isObjectRecord(value)) return "skip";
    const recognized = Object.keys(value).filter(isClaimsKey);
    if (recognized.length === 0) return "skip";
    if (recognized.length > 1 || recognized[0] !== CLAIMS_KEY) return "reject";
    return found === null ? "adopt" : "reject";
  },
};

/** A parsed chat reply that carries claims, or `null` when unusable. */
export interface ChatClaimsReply {
  readonly claims: ModelClaim[];
  readonly reason?: string;
  readonly riskLevel?: RiskLevel;
}

function isValidConcept(value: unknown): value is PolicyConcept {
  return typeof value === "string" && CONCEPTS.has(value);
}

function parseItem(raw: unknown): ModelClaim | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (!isValidConcept(record.concept)) return null;
  const presence = record.presence;
  if (typeof presence !== "string" || !isPresence(presence)) return null;
  // Out-of-range is not clamped up: a confidence the model got wrong is not
  // trusted, so it is dropped and the core reads the claim as unknown.
  const confidence =
    typeof record.confidence === "number" && record.confidence >= 0 && record.confidence <= 1
      ? record.confidence
      : undefined;
  return { concept: record.concept, presence, confidence };
}

function parseReason(value: unknown): string | undefined {
  return typeof value === "string" ? normalizeAndRedactText(value) || undefined : undefined;
}

/**
 * Parse a chat reply into model claims.
 *
 * @param text - The raw model reply.
 * @returns The parsed reply, or `null` when no usable claims object is found or
 *   any entry is invalid.
 */
export function parseChatClaims(text: string): ChatClaimsReply | null {
  const args = extractFirstJsonObject(text, CLAIMS_SHAPE);
  if (typeof args !== "object" || args === null) return null;
  const record = args as Record<string, unknown>;
  if (!Array.isArray(record.evidence) || record.evidence.length === 0) return null;
  const claims: ModelClaim[] = [];
  for (const raw of record.evidence) {
    const item = parseItem(raw);
    if (item === null) return null;
    claims.push(item);
  }
  const riskLevel =
    typeof record.riskLevel === "string" && isRiskLevel(record.riskLevel)
      ? record.riskLevel
      : undefined;
  return { claims, reason: parseReason(record.reason), riskLevel };
}
