/**
 * The audit-log event names — the log's read contract. Readers
 * (decision-log-reader) and writers (pipeline gates, engines) share these
 * so neither side redeclares the strings.
 */
export const DECISION_EVENT = "ai_guard.decision";

/**
 * The gate names a decision record carries: which stage produced the verdict.
 * Writers (the pipeline's gates) and readers (the report builder, the
 * pipeline's own log scan) share these for the same reason the event names
 * are shared — a drifted literal would make a reader silently blind to one
 * stage. Machinery failures are the exception: their gate is the failure kind
 * itself, single-sourced in `PRE_CALL_MACHINERY_KINDS`.
 */
export const DECISION_GATES = {
  /** The policy table already decided; the link defers. */
  policyDecided: "policy-decided",
  /** The deterministic screen hard-denied. */
  screen: "screen",
  /** The circuit breaker short-circuited. */
  circuitBreaker: "circuit-breaker",
  /** The session cache answered. */
  cacheHit: "cache-hit",
  /** The reviewer model answered. */
  model: "model",
} as const;

export const SHORT_CIRCUIT_EVENT = "ai_guard.short_circuit";

export const MODEL_REPLY_EVENT = "ai_guard.model_reply";

/**
 * Per-question answers from a classifier call, recorded for EVERY verdict —
 * a clean verdict's decision record keeps a sentinel in rawReply, so this
 * event is the only place a policy replay can recover what the model
 * actually answered. Values are category ids and probabilities, never free
 * text, so unlike the model-reply event it needs no redaction.
 */
export const MODEL_ANSWERS_EVENT = "ai_guard.model_answers";

export const CACHE_LOOKUP_EVENT = "ai_guard.cache_lookup";

export const MODEL_CALL_ERROR_EVENT = "ai_guard.model_call_error";

export const FALLBACK_EVENT = "ai_guard.fallback";

export const COVERAGE_EVENT = "ai_guard.coverage";
