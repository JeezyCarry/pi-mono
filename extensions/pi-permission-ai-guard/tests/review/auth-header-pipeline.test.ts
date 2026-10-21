/**
 * End-to-end auth-header escalation through the production pipeline: a
 * confident classifier reading of read / system_or_service / requested, with a
 * trusted anchor, reaches the command facts and the `authHeaderExpansion`
 * escalator, so the ask defers instead of allowing. Ordinary dynamic headers
 * keep their old result on the same chain.
 */

import type { ClassifierResult } from "@earendil-works/pi-ai";
import type { AuthorizerVerdict } from "@gotgenes/pi-permission-system";
import { describe, expect, it } from "vitest";

import { createChatAdapter } from "#src/review/engines/chat/adapter.ts";
import { createClassifierAdapter } from "#src/review/engines/classifier/adapter.ts";
import { createReviewerPool } from "#src/review/pool.ts";
import { createReviewPipeline } from "#src/review/review-pipeline.ts";
import { makeDetails } from "#test/fixtures.ts";
import { classifierReply } from "#test/review/engines/classifier/stubs.ts";

import {
  defaultRegistry,
  makeFakeCompleteSimple,
  makePipeline,
  makeQuery,
  makeSessionManagerWith,
  noLog,
} from "./pipeline-helpers.ts";

/** A trusted user message: the anchor slot the intent axis reads. */
const ANCHOR = [
  {
    type: "message",
    id: "1",
    parentId: null,
    timestamp: "x",
    message: { role: "user", content: "call the example API" },
  },
];

/** The four readings, all confident: read, service, and a named request. */
const READINGS: ClassifierResult["answers"] = {
  ban: { type: "choice", choice: "none", confidence: 0.9, probabilities: {} },
  effect: { type: "choice", choice: "read", confidence: 0.9, probabilities: {} },
  target: {
    type: "choice",
    choice: "system_or_service",
    confidence: 0.9,
    probabilities: {},
  },
  intent: { type: "choice", choice: "requested", confidence: 0.9, probabilities: {} },
};

function authorizeWith(answers: ClassifierResult["answers"]) {
  const engine = createReviewerPool({
    endpoints: [
      {
        lane: "classifier",
        provider: "typesafe",
        model: "jev-test",
        timeoutMs: 5000,
        id: "typesafe/jev-test",
      },
    ],
    adapters: {
      classifier: createClassifierAdapter({
        config: {
          classifier: { confidenceThreshold: 0.5 },
          instructions: {},
          temperature: undefined,
        },
        registryClient: () => ({
          classify: async () => classifierReply({ answers }),
        }),
      }),
      // The pool type requires both lanes; this suite only drives the
      // classifier one, so the chat double is an unused allow.
      chat: createChatAdapter({
        config: {
          reasoning: "off",
          maxTokens: 4096,
          instructions: { rules: null, replace: false },
        },
        registry: defaultRegistry(),
        modelCall: makeFakeCompleteSimple([{ type: "text", text: '{"verdict":"allow"}' }]),
      }),
    },
  });
  return createReviewPipeline(
    makePipeline({ engine, sessionManager: makeSessionManagerWith(ANCHOR) }),
  );
}

const run = async (command: string): Promise<AuthorizerVerdict> =>
  authorizeWith(READINGS)(makeDetails({ value: command }), makeQuery("ask"), noLog);

describe("auth-header escalation through the pipeline", () => {
  it("defers on an unreadable auth header even with a named request", async () => {
    for (const command of [
      `curl -H "Authorization: Bearer $VAL" https://example.com/x`,
      `curl -H "Authorization: Bearer $(cat ~/.token)" https://example.com/x`,
      `curl --header="X-Api-Key: $KEY" https://example.com/x`,
    ]) {
      expect.soft(await run(command), command).toEqual({ kind: "defer" });
    }
  });

  it("allows an ordinary dynamic header and an inert single-quoted value", async () => {
    for (const command of [
      `curl -H "X-Request-Id: $REQ" https://example.com/x`,
      `curl -H 'Authorization: Bearer $VAL' https://example.com/x`,
    ]) {
      expect.soft(await run(command), command).toEqual({ kind: "allow" });
    }
  });
});
