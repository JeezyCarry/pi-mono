/**
 * Failure taxonomy: the single table deciding whether a backend failure
 * switches to the next endpoint or ends the ask as a terminal defer.
 * One module behind a small interface — "given what the backend said,
 * switch or terminal, and with what defer kind".
 *
 * The classifier lane feeds it through one entry, `classifyBackendError`:
 * it reads one of the lane's own error shapes — {@link classifierError}'s
 * product — and returns whether the backend could not serve the request (a
 * failover reason) plus the defer kind it records: one pass, one refusal
 * guard. The chat lane reads its untyped provider errors through
 * `availabilityReason`; the two lanes are deliberately asymmetric, so this
 * entry is not shared across them.
 *
 * Failover switches backends, it does not hammer the same one: a
 * different backend has no 409 conflict state, so 409/425 switch here
 * even though a same-backend retry never covered them. And failover
 * never routes around a provider's refusal: auth/policy/invalid-request
 * signals — by status or by phrase — are terminal defers for the
 * operator.
 */

import type { AvailabilityReason, ModelCallDeferKind } from "#src/model/model-verdict.ts";
import { attempt, classifyAbortish, errorMessage, isObjectRecord } from "#src/utils.ts";

/** HTTP statuses that switch backends (failover, not same-backend retry). */
const SWITCHABLE_STATUS: ReadonlySet<number> = new Set([402, 404, 408, 409, 410, 425, 429]);

/**
 * Classify a numeric HTTP status by the shared switchable table.
 *
 * @param status - The HTTP status (or unknown value).
 * @returns The `http-xxx` reason when the status switches, else undefined.
 */
export function switchableStatusReason(status: unknown): AvailabilityReason | undefined {
  return typeof status === "number" &&
    (SWITCHABLE_STATUS.has(status) || (status >= 500 && status < 600))
    ? `http-${status}`
    : undefined;
}

/** Wording a provider uses when a call timed out or was cut short. */
const TIMEOUT_PHRASE = /timed out|timeout|aborted/i;

/** Node error codes that mean the connection never served the request. */
const CONNECTION_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
]);

/** Auth/policy/invalid-request signals: never route around a provider's refusal. */
const REFUSAL_STATUS = /\b(?:400|401|403|405|406|407|411|412|413|414|415|422|423|424|451)\b/;
const REFUSAL_PHRASE =
  /\b(?:unauthori[sz]ed|forbidden|access denied|permission denied|content policy|policy violation|policy blocked|content blocked|invalid (?:request|api key)|authentication failed)\b/i;

/**
 * Does the error's own text carry a refusal signal?
 *
 * A refusal wrapped with "aborted" or a quota hint must stay terminal — failing
 * over to the next provider could turn it into an allow.
 *
 * @param message - The error text to test.
 * @returns True for an auth, policy, or invalid-request signal.
 */
export function mentionsRefusal(message: string): boolean {
  return REFUSAL_STATUS.test(message) || REFUSAL_PHRASE.test(message);
}

/** Timeout signals (matched against trimmed input). */
const TIMEOUT_RULE = /^(?:request |operation )?(?:timed out|timeout|aborted)\b/i;

/** Quota signals (matched anywhere — evaluation order preserved: quota before connection). */
const QUOTA_RULE =
  /\b(?:FreeUsageLimitError|GoUsageLimitError|insufficient_quota|quota exceeded|out of budget)\b/i;

/** Connection signals (matched against trimmed input). */
const CONNECTION_RULE =
  /^(?:fetch failed|network error|connection (?:refused|lost|error)|socket hang up|service unavailable)\b/i;

/**
 * Read a field off an error-shaped object without throwing on accessors.
 *
 * @param error - The thrown value or wrapper object.
 * @param key - The field to read.
 * @returns The field value, or undefined when absent/unreadable.
 */
function errorField(error: unknown, key: string): unknown {
  // A throwing getter is not a status — read it as absent.
  return attempt(() => (isObjectRecord(error) ? error[key] : undefined));
}

/**
 * Identify service outages without mistaking auth/policy refusals for outages.
 * Pi providers may throw errors or return a stopReason:error reply. Status
 * takes precedence over message text, so a 403 mentioning "rate limit"
 * cannot silently route the request around a provider's refusal.
 *
 * @param error - A thrown provider error or the errorMessage of a failed reply.
 * @returns Safe reason for trying the next model, if known.
 */
export function availabilityReason(error: unknown): AvailabilityReason | undefined {
  // A present status field is authoritative and fail-closed: numeric
  // values classify by the shared table, non-numeric values never
  // switch. A typed refusal (e.g. 403) stops here and never falls
  // through to a nested 5xx. Only when no top-level status exists do
  // we consult response/cause chains.
  const topStatus = errorField(error, "status") ?? errorField(error, "statusCode");
  if (topStatus !== undefined) return switchableStatusReason(topStatus);
  const response = errorField(error, "response");
  const nested =
    typeof response === "object" && response !== null ? response : errorField(error, "cause");
  const nestedStatus =
    typeof nested === "object" && nested !== null ? errorField(nested, "status") : undefined;
  if (nestedStatus !== undefined) return switchableStatusReason(nestedStatus);
  const code = errorField(error, "code") ?? errorField(nested, "code");
  if (typeof code === "string" && CONNECTION_CODES.has(code)) return "connection";
  const message = errorMessage(error);
  // A wrapped 403 can also mention quota or a 429 in its body. Refuse to
  // route around any explicit auth, policy or invalid-request HTTP status.
  if (mentionsRefusal(message)) return undefined;
  // Provider errors often resolve into AssistantMessage.errorMessage without
  // a typed status. Match a prefixed status or an explicit status field;
  // unrelated numbers in error bodies must not become HTTP status codes.
  const trimmed = message.trim();
  const http =
    /^(?:(?:Error:\s*)?HTTP(?:\/\d(?:\.\d)?)?\s*|Error:\s*)?(\d{3})\b/i.exec(trimmed) ??
    // `[:=]` must sit inside the group: as a sibling it lets the two `\s*`
    // split one whitespace run O(n) ways per start position (quadratic).
    /\b(?:status(?: code)?|upstream returned)\s*(?:[:=]\s*)?(\d{3})\b/i.exec(message);
  if (http) return switchableStatusReason(Number(http[1]));
  if (error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name)) {
    return "timeout";
  }
  if (TIMEOUT_RULE.test(trimmed)) return "timeout";
  if (QUOTA_RULE.test(message)) return "quota";
  if (CONNECTION_RULE.test(trimmed)) return "connection";
  return undefined;
}

/**
 * The classifier lane's error shapes. The lane's transport (pi's
 * `classify`) never rejects a served-but-failed request, so the facade
 * rebuilds one of these from the result's `errorMessage`, and
 * {@link classifyBackendError} reads them by `instanceof`. They replace
 * the TypeSafe SDK's error classes, which the lane no longer depends on.
 */
export class ClassifierApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ClassifierApiError";
  }
}

/** A status-less timeout/abort signal from the classifier lane. */
export class ClassifierTimeoutError extends Error {
  constructor(message = "classifier timed out") {
    super(message);
    this.name = "ClassifierTimeoutError";
  }
}

/** A status-less, timeout-less failure the lane could not otherwise classify. */
export class ClassifierConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClassifierConnectionError";
  }
}

/** A status embedded in a classifier error message (`"... (429): <body>"`). */
const STATUS_PATTERN = /\((\d{3})\)/;

/**
 * One reader for the status in a classifier error message
 * (`"... (429): <body>"`): the rebuild ({@link classifierError}) and the
 * facade's abort branch must not drift on "does this carry a status?".
 *
 * @param message - The classifier result's error message.
 * @returns The embedded status, or undefined.
 */
export function classifierStatus(message: string): number | undefined {
  const status = STATUS_PATTERN.exec(message)?.[1];
  return status === undefined ? undefined : Number(status);
}

/**
 * Rebuild one classifier failure's typed error from its `errorMessage`
 * (`"System One API error (429): <body>"`). A status-bearing failure becomes
 * {@link ClassifierApiError} so the failover table reads the status first —
 * never the wording, or a refusal that mentions a timeout would route around
 * the policy. Status-less timeout/abort wording becomes
 * {@link ClassifierTimeoutError}; anything else {@link ClassifierConnectionError}.
 *
 * A refusal stays an untyped error: the wording guards decide (terminal),
 * because failing over past a policy answer would ask a second model the
 * refused question.
 *
 * @param message - The classifier result's error message.
 * @returns The lane-shaped error for the adapter's classification.
 */
export function classifierError(message: string): Error {
  const status = classifierStatus(message);
  if (status !== undefined) return new ClassifierApiError(status, message);
  if (mentionsRefusal(message)) return new Error(message);
  if (TIMEOUT_PHRASE.test(message)) return new ClassifierTimeoutError(message);
  return new ClassifierConnectionError(message);
}

export interface BackendFailure {
  /**
   * The failover reason when the backend could not serve the request (worth
   * trying the next endpoint); undefined when the failure is terminal.
   */
  reason: AvailabilityReason | undefined;
  deferKind: ModelCallDeferKind;
}

/**
 * Classify one backend failure for the classifier lane: whether it is
 * worth failing over (a reason) and the defer kind it records. A refusal
 * is terminal: an auth, policy, or invalid-request answer must never be
 * routed around (or recorded) as a retryable timeout.
 *
 * @param error - The thrown lane error.
 * @returns The failure's disposition.
 */
export function classifyBackendError(error: unknown): BackendFailure {
  if (error instanceof ClassifierTimeoutError) return { reason: "timeout", deferKind: "timeout" };
  if (error instanceof ClassifierConnectionError) {
    return { reason: "connection", deferKind: nonTimeoutKind(error) };
  }
  if (error instanceof ClassifierApiError) {
    return { reason: switchableStatusReason(error.status), deferKind: nonTimeoutKind(error) };
  }
  // An untyped error carries no status class: a refusal is terminal and
  // never a timeout, guarded before the abort heuristic. Anything else —
  // a wiring bug (a stale module throwing `TypeError` at call time), an
  // SDK-internal failure the lane never typed — is availability on its
  // face: the backend could not serve the request, and a backup reviewer
  // may still answer. A wrong guess only costs one extra call.
  if (mentionsRefusal(errorMessage(error))) return { reason: undefined, deferKind: "call-failed" };
  const timedOut = classifyAbortish(error) === "timeout";
  return {
    reason: timedOut ? "timeout" : "unknown-error",
    deferKind: timedOut ? "timeout" : "call-failed",
  };
}

/**
 * The defer kind for a typed error that is not itself a timeout or abort.
 *
 * @param error - The typed lane error.
 * @returns The terminal defer kind.
 */
function nonTimeoutKind(error: unknown): ModelCallDeferKind {
  return mentionsRefusal(errorMessage(error))
    ? "call-failed"
    : (classifyAbortish(error) ?? "call-failed");
}
