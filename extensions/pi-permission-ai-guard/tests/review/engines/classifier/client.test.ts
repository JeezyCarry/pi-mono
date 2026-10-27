import { describe, expect, it } from "vitest";

import { CLASSIFIER_QUESTION_IDS } from "#src/config/config-schema.ts";
import { BAN_LABELS, CLASSIFIER_QUESTION_SET } from "#src/review/axes/questions.ts";
import { buildClassifierRequest, flattenEntry } from "#src/review/engines/classifier/client.ts";
import type { ClassifierOverlay } from "#src/review/engines/classifier/instructions.ts";
import type { AskContext } from "#src/review/request/ask.ts";
import { buildAskContext } from "#src/review/request/ask.ts";
import type { ReviewRequestContext } from "#src/review/request/review-request.ts";
import type { StrippedTranscript } from "#src/review/request/transcript-stripper.ts";
import { ev, makeDetails, payload } from "#test/fixtures.ts";
import { EXCLUSION } from "#test/review/engines/shared.ts";

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
  it("builds the axis questions in the pi-ai context shape", () => {
    const req = buildClassifierRequest(transcript(), request(), NO_INSTRUCTIONS);
    // One question per registry axis, keyed by the config-level ids — the
    // two lists cannot drift because this pin reads both.
    expect(Object.keys(req.questions).toSorted()).toEqual([...CLASSIFIER_QUESTION_IDS].toSorted());
    expect(CLASSIFIER_QUESTION_SET.map((axis) => axis.id).toSorted()).toEqual(
      [...CLASSIFIER_QUESTION_IDS].toSorted(),
    );
    // Instructions are pi-ai's flat strings; every axis answers as a choice
    // (the per-label confidence channel), with a populated criteria menu.
    for (const q of Object.values(req.questions)) {
      expect(q.type).toBe("choice");
      expect(typeof q.instructions).toBe("string");
      expect(q.instructions.length).toBeGreaterThan(0);
      expect(Object.keys(q.criteria).length).toBeGreaterThan(0);
    }
    // A sample of the wire shape: legal labels only, one definition each.
    expect(req.questions.ban.criteria).toMatchObject({
      forbids: expect.any(String),
      none: expect.any(String),
      unestablished: expect.any(String),
    });
    expect(req.questions.effect.criteria).toMatchObject({
      read: expect.any(String),
      modify: expect.any(String),
      delete: expect.any(String),
      send_out: expect.any(String),
      run_program: expect.any(String),
      cannot_determine: expect.any(String),
    });
    expect(req.questions.target.criteria).toMatchObject({
      ordinary_files: expect.any(String),
      credential_material: expect.any(String),
      vcs_history: expect.any(String),
      system_or_service: expect.any(String),
      none: expect.any(String),
      cannot_determine: expect.any(String),
    });
    expect(req.questions.intent.criteria).toMatchObject({
      requested: expect.any(String),
      not_requested: expect.any(String),
      cannot_determine: expect.any(String),
    });
  });

  it("declares a coherent label/criteria contract per axis", () => {
    for (const axis of CLASSIFIER_QUESTION_SET) {
      // The declared legal labels are exactly the criteria keys: the model
      // sees one positive definition per legal label (the choice menu), and
      // the verdict layer reads each label directly off the five axes.
      expect(Object.keys(axis.criteria).toSorted()).toEqual([...axis.labels].toSorted());
      for (const label of axis.labels) {
        expect(axis.criteria[label].length).toBeGreaterThan(0);
      }
    }
    // The ban wall keeps an independent unestablished route (not confidence).
    expect(BAN_LABELS).toContain("unestablished");
  });

  it("keeps the no-hit answer reachable in the target criteria map", () => {
    // The release rows read `none` and `ordinary_files`: dropping either
    // without the policy would turn clean reviews into defers, and a test
    // that derives the label from the registry cannot see it.
    const axis = CLASSIFIER_QUESTION_SET.find((a) => a.id === "target");
    expect(axis?.criteria).toHaveProperty("none");
    expect(axis?.criteria).toHaveProperty("ordinary_files");
  });

  it("states the request scope in the intent criterion", () => {
    // `requested` requires the command to stay inside what the request
    // named: extra files, stronger flags, and chained extra commands all
    // exceed the named scope and read `not_requested`.
    const axis = CLASSIFIER_QUESTION_SET.find((a) => a.id === "intent");
    const criterion = axis?.criteria.requested ?? "";
    expect(criterion).toMatch(/stays inside what/i);
    expect(criterion).toMatch(/named/i);
    // Positive phrasing only: no exclusion or carve-out vocabulary.
    expect(criterion).not.toMatch(
      /is not|are not|never|not this|excluding|rather than|instead of|as opposed to/i,
    );
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

  it("carries observed facts in state for a package-script entry", () => {
    // The snapshot rides the request context — buildState consumes it,
    // never the disk. A null snapshot (non-bash, or no snapshot taken)
    // leaves the field absent.
    const withFacts = buildClassifierRequest(
      transcript(),
      {
        ...request(),
        observedFacts: {
          source: "package.json:scripts.migrate",
          runner: "npm",
          scripts: { migrate: "node scripts/migrate-db.js" },
          scope: "entry-declaration-only",
          lifecycleDeclared: false,
          keys: ["migrate"],
          manifestDir: "/project",
        },
      },
      NO_INSTRUCTIONS,
    );
    expect(withFacts.state).toMatchObject({
      observed_facts: {
        source: "package.json:scripts.migrate",
        runner: "npm",
        scope: "entry-declaration-only",
        lifecycle_declared: false,
        downstream: "unresolved",
        trust: "untrusted-project-text-not-authorization",
        keys: ["migrate"],
        scripts: { migrate: "node scripts/migrate-db.js" },
        manifest_dir: "/project",
      },
    });
    const req = buildClassifierRequest(transcript(), request(), NO_INSTRUCTIONS);
    expect(req.state).not.toHaveProperty("observed_facts");
  });

  it("redacts credential-shaped source and keys on the way to the service", () => {
    // The observed-facts evidence is untrusted project text: its source,
    // keys, and scripts all go through the same normalizeAndRedactText as
    // the command (the chat prompt's twin). A secret embedded in a script
    // name or the source annotation must not reach the service in the clear.
    const aws = "AKIAIOSFODNN7EXAMPLE";
    const withFacts = buildClassifierRequest(
      transcript(),
      {
        ...request(),
        observedFacts: {
          source: `package.json:scripts.${aws}`,
          runner: "npm",
          scripts: { [aws]: `node ${aws}.js` },
          scope: "entry-declaration-only",
          lifecycleDeclared: true,
          keys: [`deploy-${aws}`, aws, `${aws}-post`],
          manifestDir: `/srv/${aws}/pkg`,
        },
      },
      NO_INSTRUCTIONS,
    );
    const state = withFacts.state as { observed_facts: Record<string, unknown> };
    expect(JSON.stringify(state.observed_facts)).not.toContain(aws);
    expect(state.observed_facts.source).toContain("[REDACTED]");
    for (const key of state.observed_facts.keys as string[]) {
      expect(key).toContain("[REDACTED]");
    }
    expect(JSON.stringify(state.observed_facts.scripts)).toContain("[REDACTED]");
    expect(state.observed_facts.manifest_dir).toContain("[REDACTED]");
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
    expect(req.questions.ban.type).toBe("choice");
    expect(req.questions.ban.criteria).toHaveProperty("forbids");
    expect(req.questions.effect.criteria).toHaveProperty("send_out");
  });

  it("overlays a per-question string only on that question", () => {
    const req = buildClassifierRequest(transcript(), request(), {
      questions: { intent: "Authorization covers exactly the scope the anchor names." },
    });
    expect(String(req.questions.intent.instructions)).toContain(
      "exactly the scope the anchor names",
    );
    expect(String(req.questions.ban.instructions)).not.toContain(
      "exactly the scope the anchor names",
    );
  });

  it("overlays a per-question string on ban", () => {
    const req = buildClassifierRequest(transcript(), request(), {
      questions: { ban: "A later instruction that explicitly lifts a ban ends its effect." },
    });
    expect(String(req.questions.ban.instructions)).toContain("lifts a ban");
    expect(String(req.questions.intent.instructions)).not.toContain("lifts a ban");
  });

  it("overlays a per-question string on effect", () => {
    const req = buildClassifierRequest(transcript(), request(), {
      questions: {
        effect: "An `observed_facts` record about the content itself decides.",
      },
    });
    expect(String(req.questions.effect.instructions)).toContain("content itself decides");
    expect(String(req.questions.ban.instructions)).not.toContain("content itself decides");
  });

  it("composes object overlays as structured context inside the flat instructions", () => {
    // pi-ai's question instructions are one flat string, so the structured
    // context travels as a serialized tail — dropping it would silently
    // change reviewer behavior under an overlay.
    const req = buildClassifierRequest(transcript(), request(), {
      background: { deploy_tool: "railway up", forbidden: ["kubectl"] },
    });
    expect(req.questions.ban.instructions).toContain("Structured context:");
    expect(req.questions.ban.instructions).toContain(
      JSON.stringify({ deploy_tool: "railway up", forbidden: ["kubectl"] }),
    );
  });

  it("keeps the shared background context when a question adds its own", () => {
    const req = buildClassifierRequest(transcript(), request(), {
      background: { deploy_tool: "railway up" },
      questions: { ban: { ban_note: "lifted ends its effect" } },
    });
    expect(req.questions.ban.instructions).toContain(
      JSON.stringify({ deploy_tool: "railway up", ban_note: "lifted ends its effect" }),
    );
  });

  it("appends a per-question string to the question text, keeping the background context", () => {
    const req = buildClassifierRequest(transcript(), request(), {
      background: { deploy_tool: "railway up" },
      questions: { ban: "judge the still-effective instruction" },
    });
    expect(req.questions.ban.instructions).toContain("judge the still-effective instruction");
    expect(req.questions.ban.instructions).toContain(JSON.stringify({ deploy_tool: "railway up" }));
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
    // merged changeset. Both the exclusion literal and the exclusion
    // sentence shapes are caught: a category says what it IS, and neither
    // what it is not nor what stays elsewhere.
    const offenders = CLASSIFIER_QUESTION_SET.flatMap((axis) =>
      Object.entries(axis.criteria)
        .filter(([, criteria]) => EXCLUSION.test(criteria))
        .map(([label]) => `${axis.id}.${label}`),
    );
    expect(offenders).toEqual([]);
  });

  it("keeps the anchor state key out of every non-intent criteria text", () => {
    // One axis per question, made machine-checkable. Only `ban` and `intent`
    // judge the record — the standing instruction, and the request's word —
    // so they may name it. The exclusion scan above checks PHRASING
    // ("not-X" shapes) and is blind to this coupling.
    const anchorAxes = new Set(["ban", "intent"]);
    const offenders = CLASSIFIER_QUESTION_SET.flatMap((axis) =>
      anchorAxes.has(axis.id)
        ? []
        : Object.entries(axis.criteria)
            .filter(([, criteria]) => criteria.includes("authorization_anchor"))
            .map(([label]) => `${axis.id}.${label}`),
    );
    expect(offenders).toEqual([]);
  });

  it("tells the intent question that exceeding the named scope is not requested", () => {
    // Single-select cannot express partial coverage, so a command that adds
    // files, flags, or chained commands beyond the named scope must read
    // `not_requested`: the exceeding part still needs its own naming.
    const intent = CLASSIFIER_QUESTION_SET.find((axis) => axis.id === "intent");
    expect(intent?.criteria.not_requested).toContain("exceeds");
  });

  it("keeps every question instruction positive too", () => {
    // Same convention, extended to the question lines themselves: each grades
    // one axis by what the action IS, and cross-references a sister axis only
    // by naming it in a comment, never by an exclusion clause.
    const texts = CLASSIFIER_QUESTION_SET.map((axis) => axis.instructions);
    expect(texts.filter((text) => EXCLUSION.test(text))).toEqual([]);
  });
});
