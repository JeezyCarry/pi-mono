import { describe, expect, it } from "vitest";

import { buildClassifierRequest, flattenEntry } from "#src/review/engines/classifier/client.ts";
import type { ClassifierOverlay } from "#src/review/engines/classifier/instructions.ts";
import { DANGER_CRITERIA, DANGER_NONE } from "#src/review/engines/classifier/questions.ts";
import type { AskContext } from "#src/review/request/ask.ts";
import { buildAskContext } from "#src/review/request/ask.ts";
import type { ReviewRequestContext } from "#src/review/request/review-request.ts";
import type { StrippedTranscript } from "#src/review/request/transcript-stripper.ts";
import { ev, makeDetails, payload } from "#test/fixtures.ts";

function ask(): AskContext {
  return buildAskContext(makeDetails({ value: "rm -rf /tmp/x" }), "/project");
}

function request(overrides: Partial<ReviewRequestContext> = {}): ReviewRequestContext {
  return { ask: ask(), target: "rm -rf /tmp/x", ...overrides };
}

function transcript(overrides: Partial<StrippedTranscript> = {}): StrippedTranscript {
  return {
    trustedIntent: ["clean up temp files"],
    toolCalls: [],
    strippedCount: 0,
    ...overrides,
  };
}

/** The lane's resolved instructions with no content. */
const NO_INSTRUCTIONS: ClassifierOverlay = {};

describe("flattenEntry", () => {
  it("passes strings through", () => {
    expect(flattenEntry("q")).toBe("q");
  });

  it("serializes structured context instead of dropping it", () => {
    const out = flattenEntry({ question: "q", context: { k: "v" } });
    expect(out).toContain("q");
    expect(out).toContain(JSON.stringify({ k: "v" }));
  });
});

describe("buildClassifierRequest", () => {
  // The criteria and instructions copy is freely iterable, so pin the
  // load-bearing structure — question ids, answer types, criteria shape —
  // rather than the prose. The one exception is the DANGER_CRITERIA form
  // invariant below: it forbids an exclusion clause, so any legal reword
  // passes and only a convention violation fails.
  it("builds the built-in questions in the pi-ai context shape", () => {
    const req = buildClassifierRequest(transcript(), request(), NO_INSTRUCTIONS);
    expect(Object.keys(req.questions).toSorted()).toEqual([
      "danger_category",
      "intent_match",
      "risk",
    ]);
    expect(req.questions.danger_category.type).toBe("choice");
    expect(req.questions.risk.type).toBe("score");
    expect(req.questions.intent_match.type).toBe("bool");
    // Instructions are pi-ai's flat strings; the criteria keep their shapes.
    for (const q of Object.values(req.questions)) {
      expect(typeof q.instructions).toBe("string");
      expect(q.instructions.length).toBeGreaterThan(0);
    }
    expect(req.questions.intent_match.criteria).toMatchObject({
      true: expect.any(String),
      false: expect.any(String),
    });
    expect(req.questions.risk.criteria).toHaveLength(5);
  });

  it("keeps the no-hit answer reachable in the criteria map", () => {
    // The allow path turns on `dangerCategory !== DANGER_NONE`. Renaming the
    // map's key without the constant would turn every clean review into a
    // deny, and a test that reads the constant on both sides cannot see it.
    expect(DANGER_CRITERIA).toHaveProperty(DANGER_NONE);
  });

  it("puts the anchor, earlier context, and command in state", () => {
    const req = buildClassifierRequest(
      transcript({ trustedIntent: ["older", "clean up temp files"], toolCalls: ["ls"] }),
      request(),
      NO_INSTRUCTIONS,
    );
    expect(req.state).toMatchObject({
      command: "rm -rf /tmp/x",
      authorization_anchor: "clean up temp files",
      earlier_context: ["older"],
      tool_calls: ["ls"],
      working_directory: "/project",
    });
  });

  it("carries tool input in state for a tool ask with empty flagged elements", () => {
    // A tool-kind ask whose value is empty flags nothing — exactly the
    // blind-on-intent shape the tool_input key exists for (B1 regression).
    const toolAsk = buildAskContext(
      makeDetails({
        payload: payload("tool", { value: "", surface: "mcp" }, [ev("input", "preview")]),
      }),
      "/project",
    );
    expect(toolAsk.flaggedElements).toEqual([]);
    const req = buildClassifierRequest(
      transcript(),
      { ask: toolAsk, target: "mcp" },
      NO_INSTRUCTIONS,
    );
    expect(req.state).toMatchObject({ tool_input: "preview" });
  });

  it("uses (none found) when there is no trusted intent", () => {
    const req = buildClassifierRequest(
      transcript({ trustedIntent: [] }),
      request(),
      NO_INSTRUCTIONS,
    );
    expect(req.state).toMatchObject({ authorization_anchor: "(none found)" });
  });

  it("takes a question tool's answer as the anchor", () => {
    // The stripper puts a question tool's payload into trusted intent, so the
    // anchor the classifier judges is the same one the chat lane judges — even
    // though the answer arrived as a tool result, not a user message.
    const answer = JSON.stringify({
      answers: [{ questionIndex: 0, question: "怎么处理？", kind: "option", answer: "授权你改" }],
      cancelled: false,
    });
    const req = buildClassifierRequest(
      transcript({ trustedIntent: ["older", answer] }),
      request(),
      NO_INSTRUCTIONS,
    );
    expect(req.state).toMatchObject({ authorization_anchor: answer, earlier_context: ["older"] });
  });

  it("appends the shared background to every question", () => {
    const req = buildClassifierRequest(transcript(), request(), {
      background: "Deploys go through railway up.",
    });
    for (const q of Object.values(req.questions)) {
      expect(String(q.instructions)).toContain("Deploys go through railway up.");
    }
  });

  it("keeps the built-in reviewer role leading every question", () => {
    // The role sentence is answer-contract scaffolding: a user background
    // appends after it rather than replacing it, and the anchor the criteria
    // read is the request's `authorization_anchor` state key, not this text.
    const roleMarker = "You are reviewing one tool call";
    const req = buildClassifierRequest(transcript(), request(), {
      background: "Act as our monorepo reviewer.",
    });
    for (const q of Object.values(req.questions)) {
      const instructions = String(q.instructions);
      expect(instructions).toContain(roleMarker);
      expect(instructions.indexOf(roleMarker)).toBeLessThan(
        instructions.indexOf("Act as our monorepo reviewer."),
      );
    }
    // The answer contract is untouched by the overlay: ids, types, criteria.
    expect(req.questions.danger_category.type).toBe("choice");
    expect(req.questions.danger_category.criteria).toHaveProperty("irreversible_destruction");
    expect(req.questions.risk.type).toBe("score");
    expect(req.questions.risk.criteria).toHaveLength(5);
  });

  it("overlays a per-question string only on that question", () => {
    const req = buildClassifierRequest(transcript(), request(), {
      questions: { intent_match: "A deploy without a service name is not authorization." },
    });
    expect(String(req.questions.intent_match.instructions)).toContain("not authorization");
    expect(String(req.questions.risk.instructions)).not.toContain("not authorization");
  });

  it("overlays a per-question string on danger_category", () => {
    const req = buildClassifierRequest(transcript(), request(), {
      questions: { danger_category: "A deploy tool wiping its cache counts as none." },
    });
    expect(String(req.questions.danger_category.instructions)).toContain("wiping its cache");
    expect(String(req.questions.risk.instructions)).not.toContain("wiping its cache");
  });

  it("overlays a per-question string on risk", () => {
    const req = buildClassifierRequest(transcript(), request(), {
      questions: { risk: "Railway deploys are reversible — score accordingly." },
    });
    expect(String(req.questions.risk.instructions)).toContain("reversible");
    expect(String(req.questions.danger_category.instructions)).not.toContain("reversible");
  });

  it("composes object overlays as structured context inside the flat instructions", () => {
    // pi-ai's question instructions are one flat string, so the structured
    // context travels as a serialized tail — dropping it would silently
    // change reviewer behavior under an overlay.
    const req = buildClassifierRequest(transcript(), request(), {
      background: { deploy_tool: "railway up", forbidden: ["kubectl"] },
    });
    expect(req.questions.risk.instructions).toContain("Structured context:");
    expect(req.questions.risk.instructions).toContain(
      JSON.stringify({ deploy_tool: "railway up", forbidden: ["kubectl"] }),
    );
  });

  it("keeps the shared background context when a question adds its own", () => {
    const req = buildClassifierRequest(transcript(), request(), {
      background: { deploy_tool: "railway up" },
      questions: { risk: { rubric_note: "reversible" } },
    });
    expect(req.questions.risk.instructions).toContain(
      JSON.stringify({ deploy_tool: "railway up", rubric_note: "reversible" }),
    );
  });

  it("appends a per-question string to the question text, keeping the background context", () => {
    const req = buildClassifierRequest(transcript(), request(), {
      background: { deploy_tool: "railway up" },
      questions: { risk: "score conservatively" },
    });
    expect(req.questions.risk.instructions).toContain("score conservatively");
    expect(req.questions.risk.instructions).toContain(
      JSON.stringify({ deploy_tool: "railway up" }),
    );
  });

  it("falls back to the resolved target when the ask carries no action text", () => {
    // A degraded (forwarded) ask whose value is empty still has a resolved
    // target; the state must carry it rather than an empty command.
    const req = buildClassifierRequest(
      transcript(),
      { ask: buildAskContext(makeDetails({ value: "" }), "/project"), target: "/etc/passwd" },
      NO_INSTRUCTIONS,
    );
    const state = req.state as { command: string };
    expect(state.command).toBe("/etc/passwd");
  });

  it("redacts the ask fields on their way to the service", () => {
    // The pipeline hands engines the raw projection; only the transcript
    // arrives sanitized, so the classifier state redacts the ask itself (the chat
    // prompt's twin).
    const secret = "sk-ant-api03-abcdef1234567890abcdefABCDEF1234567890";
    const req = buildClassifierRequest(
      transcript(),
      request({
        ask: buildAskContext(makeDetails({ value: `export TOKEN=${secret}` }), "/project"),
      }),
      NO_INSTRUCTIONS,
    );
    const state = req.state as { command: string };
    expect(state.command).not.toContain(secret);
    expect(state.command).toContain("[REDACTED]");
  });
});

describe("DANGER_CRITERIA form", () => {
  it("states every category by positive inclusion, never by exclusion", () => {
    // The single-choice answer contract has no sibling category to route
    // "not this category" to, so an exclusion only pollutes
    // the distribution. Exemptions belong in positive qualifiers. This test
    // freezes that convention — the case that established it lives only in a
    // merged changeset.
    const offenders = Object.entries(DANGER_CRITERIA)
      .filter(([, criteria]) => criteria.includes("not this category"))
      .map(([category]) => category);
    expect(offenders).toEqual([]);
  });
});
