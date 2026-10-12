/**
 * The audit-log event names — the log's read contract. Readers
 * (decision-log-reader) and writers (pipeline gates, engines) share these
 * so neither side redeclares the strings.
 */
export const DECISION_EVENT = "ai_guard.decision";

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
