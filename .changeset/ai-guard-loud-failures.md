---
"pi-permission-ai-guard": patch
---

**A reviewer that cannot answer now says so.** Previously a broken or unreachable reviewer looked exactly like an uncertain one: the request was deferred to you, and nothing in the decision log distinguished the two.

- An untyped failure — a wiring bug, an error the lane never classified — hands the request to the backup reviewer instead of deferring on the spot. An auth or policy refusal still stops immediately; a reviewer must not route around a refusal just because the request could not be served.
- The decision record carries the failure's class name (`TypeError`) in `diagnostic`, so the review log alone answers "was the guard broken?". It is the class name only: an error message can carry a URL or a key, and the sanitized text stays in the debug log for whoever wants it.
- A reviewer failure now counts toward the circuit breaker's consecutive streak (`circuitBreaker.consecutive`) in every mode. Only the `strict` and `permissive` modes counted it before, so in the default mode a reviewer that failed every call asked you again and again instead of tripping the breaker. A model's own defer is unchanged: it answered, just without confidence, and it still does not count.

The classifier lane also records a risk level on every verdict rather than only on the ones it denies, so `riskLevel` in the decision log is readable for requests you approved or were asked about.
