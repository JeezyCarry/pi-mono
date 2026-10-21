/**
 * Observed-facts wiring: the snapshot's place in the pipeline and its
 * two renderers.
 *
 * The pipeline takes the snapshot AFTER the policy and breaker gates and
 * BEFORE the cache lookup (see review-pipeline), so a policy-decided ask
 * never reads the project file. The snapshot then rides the request context
 * into both lane renderers — this suite pins the gate ordering with a real
 * pipeline run (not a unit assembly) and the two-renderer consistency.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildReviewPrompt } from "#src/review/engines/chat/prompt.ts";
import { buildClassifierRequest } from "#src/review/engines/classifier/client.ts";
import type { ClassifierOverlay } from "#src/review/engines/classifier/instructions.ts";
import { buildAskContext } from "#src/review/request/ask.ts";
import type { ReviewRequestContext } from "#src/review/request/review-request.ts";
import { snapshotRequest } from "#src/review/request/review-request.ts";
import { createReviewPipeline } from "#src/review/review-pipeline.ts";
import { makeDetails } from "#test/fixtures.ts";

import { expectVerdict, makePipeline } from "./pipeline-helpers.ts";

// Wrap the real snapshot with a spy: the pipeline imports this binding, so a
// policy-decided ask that never reaches the snapshot leaves the spy uncalled.
// The factory recovers the real signature through `importOriginal`'s type
// parameter, so the mock cannot silently drift from the module it replaces.
vi.mock("#src/review/request/review-request.ts", async (importOriginal) => {
  const actual = await importOriginal<{ snapshotRequest: typeof snapshotRequest }>();
  return {
    ...actual,
    snapshotRequest: vi.fn<typeof snapshotRequest>(actual.snapshotRequest),
  };
});

const NO_INSTRUCTIONS: ClassifierOverlay = {};

function transcript() {
  return { trustedIntent: ["run the migration"], toolCalls: [], strippedCount: 0 };
}

const dirs: string[] = [];

function makeTmp(name: string): string {
  const dir = join(tmpdir(), `${name}-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.clearAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeManifest(dir: string, scripts: Record<string, string>): void {
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts }));
}

describe("observed-facts pipeline gate", () => {
  it("a policy-decided ask short-circuits before any package.json read", async () => {
    // Both decided states pass through without a review: the snapshot (a
    // project file read) must not happen, and the ask must return without a
    // throw.
    const cwd = makeTmp("wiring-gate");
    writeManifest(cwd, { migrate: "node a.js" });
    const authorize = createReviewPipeline(makePipeline({ cwd }));
    await expectVerdict(authorize, { value: "npm run migrate" }, { kind: "defer" }, "allow");
    await expectVerdict(authorize, { value: "npm run migrate" }, { kind: "defer" }, "deny");
    expect(snapshotRequest).not.toHaveBeenCalled();
  });

  it("a policy-ask review does take the snapshot (positive control)", async () => {
    // The same wiring on the reviewing path: after the ask gate the snapshot
    // is taken exactly once per review. Without this control the gate test
    // above would pass even if the snapshot were never wired at all.
    const cwd = makeTmp("wiring-gate-positive");
    writeManifest(cwd, { migrate: "node a.js" });
    const authorize = createReviewPipeline(makePipeline({ cwd }));
    await expectVerdict(authorize, { value: "npm run migrate" }, { kind: "allow" }, "ask");
    expect(snapshotRequest).toHaveBeenCalledTimes(1);
  });
});

describe("observed-facts dual-renderer consistency", () => {
  it("renders one snapshot to both lanes and stays pinned to it after the file changes", () => {
    const cwd = makeTmp("wiring-render");
    writeManifest(cwd, { migrate: "node scripts/migrate-db.js", premigrate: "echo backup" });
    const ask = buildAskContext(makeDetails({ value: "npm run migrate" }), cwd);
    const context: ReviewRequestContext = {
      ask,
      target: "npm run migrate",
      observedFacts: snapshotRequest(ask).observedFacts,
    };

    const classifier = buildClassifierRequest(transcript(), context, NO_INSTRUCTIONS);
    const chat = buildReviewPrompt(transcript(), context);

    // Both lanes carry the SAME script evidence text.
    expect(chat).toContain("node scripts/migrate-db.js");
    expect(JSON.stringify(classifier.state)).toContain("node scripts/migrate-db.js");
    // Both render the pre/post lifecycle declaration (the fixture carries a
    // premigrate → declared).
    expect(chat).toContain("pre/post lifecycle declared: yes");
    expect(JSON.stringify(classifier.state)).toContain('"lifecycle_declared":true');

    // The file changes after the snapshot: the SAME snapshot object renders
    // unchanged from both lanes...
    writeManifest(cwd, { migrate: "node changed.js" });
    const chatOld = buildReviewPrompt(transcript(), context);
    expect(chatOld).toContain("node scripts/migrate-db.js");
    expect(chatOld).not.toContain("node changed.js");
    const classifierOld = buildClassifierRequest(transcript(), context, NO_INSTRUCTIONS);
    expect(JSON.stringify(classifierOld.state)).toContain("node scripts/migrate-db.js");
    expect(JSON.stringify(classifierOld.state)).not.toContain("node changed.js");

    // ...and a fresh snapshot sees the change on both lanes.
    const fresh: ReviewRequestContext = {
      ask,
      target: "npm run migrate",
      observedFacts: snapshotRequest(ask).observedFacts,
    };
    expect(buildReviewPrompt(transcript(), fresh)).toContain("node changed.js");
    expect(
      JSON.stringify(buildClassifierRequest(transcript(), fresh, NO_INSTRUCTIONS).state),
    ).toContain("node changed.js");
  });

  it("renders lifecycle as declaration text, not a runner guarantee", () => {
    // A manifest with no pre/post entries reports "declared: no" — the
    // renderer states what the manifest declares, it never claims which
    // runner executes (or skips) hooks.
    const cwd = makeTmp("wiring-render-lifecycle");
    writeManifest(cwd, { migrate: "node a.js" });
    const ask = buildAskContext(makeDetails({ value: "npm run migrate" }), cwd);
    const context: ReviewRequestContext = {
      ask,
      target: "npm run migrate",
      observedFacts: snapshotRequest(ask).observedFacts,
    };
    const chat = buildReviewPrompt(transcript(), context);
    expect(chat).toContain("pre/post lifecycle declared: no");
    expect(chat).toContain("declared text is not proof of execution");
  });
});
