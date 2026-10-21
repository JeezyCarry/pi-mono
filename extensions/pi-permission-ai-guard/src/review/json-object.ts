/**
 * Finding a shaped JSON object inside a model's free-text reply.
 *
 * Both model lanes are handed prose that wraps one JSON object, so neither can
 * demand clean JSON. The scan is shared; the shape is not: each lane says what
 * identifies its object (so a malformed attempt stays fail-closed) and how a
 * parsed object reconciles with one already found (so a self-contradictory
 * reply defers instead of letting the first object decide).
 */

import { parseJsonWithRepair } from "@earendil-works/pi-ai";

/** How one lane recognizes and reconciles its JSON object. */
export interface JsonObjectShape {
  /**
   * Does an unparseable fragment look like an attempted object of this shape?
   * `true` stops the search: a broken attempt is never overridden by a later
   * object.
   */
  looksLike(fragment: string): boolean;
  /**
   * Reconcile a parsed object with the one already found.
   *
   * - `adopt` — take this object as the result (nothing found yet).
   * - `skip` — unrelated; keep the current result and the search going.
   * - `reject` — contradicts the found object; the reply is ambiguous, so the scan returns `null`.
   */
  consider(found: unknown, value: unknown): "adopt" | "skip" | "reject";
}

/**
 * Find the next occurrence of `target` outside string literals.
 *
 * @param text - The text to search.
 * @param from - Index to start searching from.
 * @param target - The character to find.
 * @returns The index of the next occurrence, or -1 if not found.
 */
function findNextCharOutsideString(text: string, from: number, target: string): number {
  let inString = false;
  let escaped = false;
  for (let i = from; i < text.length; i++) {
    const ch = text.charAt(i);
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === target) return i;
  }
  return -1;
}

/**
 * From a `{` at `start`, extract the balanced `{...}` substring.
 *
 * @param text - The text to extract from.
 * @param start - Index of the opening `{`.
 * @returns The balanced `{...}` substring, or null if unbalanced.
 */
function tryExtractBalanced(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text.charAt(i);
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Extract the first JSON object of `shape` from a string, parsed.
 *
 * Tracks brace depth and respects string literals (including escaped quotes).
 * Tolerant by doctrine, with two asymmetries the shape owns:
 *
 * - A fragment that `looksLike` the shape but cannot parse stops the search and returns `null` — a
 *   broken attempt must not be overridden by a later, weaker object.
 * - Unrelated brace noise (`{var}`, markdown fragments) keeps scanning, so a model that mentions
 *   config syntax before the real object still parses.
 *
 * @param text - The text to search.
 * @param shape - How to recognize and reconcile this lane's object.
 * @returns The first accepted object, or `null` when none is found or the
 * search short-circuits.
 */
export function extractFirstJsonObject(text: string, shape: JsonObjectShape): unknown | null {
  let start = 0;
  let found: unknown | null = null;
  while (start < text.length) {
    const nextBrace = findNextCharOutsideString(text, start, "{");
    if (nextBrace < 0) return found;
    const candidate = tryExtractBalanced(text, nextBrace);
    // A cut-off attempt never reaches the parse below, so catch it here: its
    // lost closing brace must not let a later object decide.
    if (candidate === null) {
      if (shape.looksLike(text.slice(nextBrace))) return null;
    } else {
      try {
        const parsed = parseJsonWithRepair(candidate);
        const ruling = shape.consider(found, parsed);
        if (ruling === "reject") return null;
        if (ruling === "adopt") found = parsed;
      } catch {
        // A malformed attempt defers rather than being overridden by an
        // unrelated later object; other brace noise keeps scanning.
        if (shape.looksLike(candidate)) return null;
      }
    }
    start = nextBrace + 1;
  }
  return found;
}
