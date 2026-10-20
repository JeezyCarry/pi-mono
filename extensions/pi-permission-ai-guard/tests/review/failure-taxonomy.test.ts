/**
 * Failure-taxonomy direct tests: the switch/terminal matrix through the
 * module's own interface. The lane adapters rewire these same functions
 * (their seam tests carry the behavioral twins); here each matrix cell
 * pins the decision once, so a table edit that weakens failover fails
 * here first.
 *
 * Zero behavioral intent — every expectation below mirrors the table in
 * src/review/failure-taxonomy.ts.
 */

import { describe, expect, it } from "vitest";

import {
  availabilityReason,
  ClassifierApiError,
  ClassifierConnectionError,
  ClassifierTimeoutError,
  classifierError,
  classifyBackendError,
  switchableStatusReason,
} from "#src/review/failure-taxonomy.ts";

const httpError = (status: number) => new ClassifierApiError(status, "no capacity");

describe("switchableStatusReason", () => {
  it.each([402, 404, 408, 409, 410, 425, 429, 500, 503])("switches on %i", (status) => {
    expect(switchableStatusReason(status)).toBe(`http-${status}`);
  });

  it.each([400, 401, 403, 422, 451, 200, 301])("stays terminal on %i", (status) => {
    expect(switchableStatusReason(status)).toBeUndefined();
  });

  it("never switches on a non-numeric status", () => {
    expect(switchableStatusReason("429")).toBeUndefined();
    expect(switchableStatusReason(undefined)).toBeUndefined();
  });
});

describe("availabilityReason (untyped chat-lane input)", () => {
  it.each([409, 425, 429, 503])("switches on %i", (status) => {
    expect(availabilityReason(`Error: ${status} busy`)).toBe(`http-${status}`);
  });

  it.each([400, 401, 403, 422])("refuses to route around %i", (status) => {
    expect(availabilityReason(`Error: ${status} denied`)).toBeUndefined();
  });

  it("lets a typed status win over a misleading body", () => {
    expect(availabilityReason(Object.assign(new Error("denied"), { status: 403 }))).toBeUndefined();
    expect(availabilityReason(Object.assign(new Error("conflict"), { status: 409 }))).toBe(
      "http-409",
    );
  });

  it("reads quota, timeout, and connection wording", () => {
    expect(availabilityReason("FreeUsageLimitError: free quota exhausted")).toBe("quota");
    expect(availabilityReason("request timed out")).toBe("timeout");
    expect(availabilityReason(new Error("socket hang up"))).toBe("connection");
  });

  it("never classifies an unknown failure as switchable", () => {
    expect(availabilityReason(new Error("unexpected parser bug"))).toBeUndefined();
  });

  it("prefers quota over connection wording (evaluation order)", () => {
    // Matches both rules; the documented order puts quota first.
    expect(availabilityReason("fetch failed: FreeUsageLimitError")).toBe("quota");
  });

  it("never routes around a refusal that also mentions quota", () => {
    // The refusal guard runs before the quota rule: a 403 mentioning an
    // exhausted quota is still the provider's refusal, not a failover.
    expect(availabilityReason("403 forbidden: quota exceeded")).toBeUndefined();
  });

  it("reads a status after a separator or plain whitespace", () => {
    // The separator is optional but not free-floating. These are the forms the
    // rule exists for; tightening the ambiguity must not narrow them.
    expect(availabilityReason("HTTP status: 429 busy")).toBe("http-429");
    expect(availabilityReason("status code=503")).toBe("http-503");
    expect(availabilityReason("status 429")).toBe("http-429");
    expect(availabilityReason("upstream returned:  429 x")).toBe("http-429");
  });

  it("stays linear on a long whitespace run after 'status'", () => {
    // The separator used to sit optional *beside* the whitespace, so the two
    // `\s*` could split one run O(n) ways per start position: 200k spaces cost
    // ~13s here. Every correctness case above passes either way, so only a
    // timing assertion catches the ambiguity coming back. The budget is
    // thousands of times the linear cost and still below the quadratic one.
    const message = `status${" ".repeat(200_000)}!`;
    const startedAt = performance.now();
    expect(availabilityReason(message)).toBeUndefined();
    expect(performance.now() - startedAt).toBeLessThan(2_000);
  });
});

describe("classifyBackendError — typed classifier-lane input", () => {
  it.each([402, 404, 408, 409, 410, 425, 429, 503])("switches on classifier %i", (status) => {
    expect(classifyBackendError(httpError(status)).reason).toBe(`http-${status}`);
  });

  it.each([400, 401, 403, 422])("stays terminal on classifier %i", (status) => {
    expect(classifyBackendError(httpError(status)).reason).toBeUndefined();
  });

  it("switches on timeouts and connection failures", () => {
    expect(classifyBackendError(new ClassifierTimeoutError()).reason).toBe("timeout");
    expect(classifyBackendError(new ClassifierConnectionError("socket hang up")).reason).toBe(
      "connection",
    );
  });

  it("never routes around an untyped refusal, whatever else the message says", () => {
    // This lane's provider can refuse without an SDK type. An "aborted" in the
    // same sentence must not turn a refusal into a switchable timeout: failover
    // would hand the ask to the next provider, which may answer allow.
    expect(
      classifyBackendError(new Error("request aborted by content policy")).reason,
    ).toBeUndefined();
    expect(classifyBackendError(new Error("403 aborted by the gateway")).reason).toBeUndefined();
    // The guard is narrow: a plain abort still switches.
    expect(classifyBackendError(new Error("the request was aborted")).reason).toBe("timeout");
  });
});

describe("classifyBackendError — terminal defer kind", () => {
  it("reads timeouts off the lane types", () => {
    expect(classifyBackendError(new ClassifierTimeoutError()).deferKind).toBe("timeout");
  });

  it("reads a DOM timeout as a timeout", () => {
    expect(classifyBackendError(new DOMException("aborted", "TimeoutError")).deferKind).toBe(
      "timeout",
    );
    expect(classifyBackendError(new DOMException("aborted", "AbortError")).deferKind).toBe(
      "timeout",
    );
  });

  it("falls back to call-failed past aborts", () => {
    expect(classifyBackendError(new Error("unexpected parsing bug")).deferKind).toBe("call-failed");
    expect(classifyBackendError(httpError(403)).deferKind).toBe("call-failed");
  });

  it("does not label an untyped refusal a timeout", () => {
    // The reason is already terminal; the defer kind is what the operator
    // reads, so a policy answer must not read as a timeout.
    expect(classifyBackendError(new Error("request aborted by content policy")).deferKind).toBe(
      "call-failed",
    );
  });
});

describe("classifierError — a result message to the lane's error", () => {
  it("reads a status first, whatever else the message says", () => {
    expect(classifierError("System One API error (429): slow down")).toBeInstanceOf(
      ClassifierApiError,
    );
    // Status wins over refusal wording: a 429 body that mentions a policy
    // is still a switchable status, not a terminal refusal.
    const denied = classifierError("System One API error (429): permission denied");
    expect(denied).toBeInstanceOf(ClassifierApiError);
    expect((denied as ClassifierApiError).status).toBe(429);
  });

  it("keeps a status-less refusal an untyped error, never a timeout", () => {
    expect(classifierError("403 forbidden")).not.toBeInstanceOf(ClassifierTimeoutError);
    expect(classifierError("aborted by content policy")).not.toBeInstanceOf(ClassifierTimeoutError);
  });

  it("reads timeout wording as a timeout", () => {
    expect(classifierError("the request timed out")).toBeInstanceOf(ClassifierTimeoutError);
  });

  it("falls back to a connection error for anything else", () => {
    expect(classifierError("provider exploded")).toBeInstanceOf(ClassifierConnectionError);
  });
});

describe("cross-lane agreement", () => {
  it.each([402, 404, 408, 409, 410, 425, 429, 500, 503])("both inputs switch on %i", (status) => {
    // The whole point of the unified table: the chat lane's untyped
    // string and the classifier lane's typed error agree.
    expect(availabilityReason(`Error: ${status} busy`)).toBe(`http-${status}`);
    expect(classifyBackendError(httpError(status)).reason).toBe(`http-${status}`);
  });

  it.each([400, 401, 403, 422])("both inputs stay terminal on %i", (status) => {
    expect(availabilityReason(`Error: ${status} denied`)).toBeUndefined();
    expect(classifyBackendError(httpError(status)).reason).toBeUndefined();
  });

  it.each([
    // A refusal wrapped in timeout/quota/connection wording stays terminal
    // on both entries: the refusal guard runs before any wording read, so a
    // policy answer never routes around itself by mentioning a timeout.
    "request aborted by content policy after timeout",
    "403: quota exceeded on the project",
    "access denied: socket hang up",
  ])("both inputs stay terminal on mixed wording: %s", (message) => {
    expect(availabilityReason(message)).toBeUndefined();
    expect(classifyBackendError(classifierError(message)).reason).toBeUndefined();
  });
});
