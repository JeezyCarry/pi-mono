/**
 * One review takes one project-file snapshot.
 *
 * The pipeline snapshots the observed facts once, before the cache lookup.
 * Command facts must come from that same read: `routineDevCommand` rides the
 * cache key, so a manifest read twice could key one state and rule on another.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { snapshotObservedFacts } from "#src/review/request/observed-facts.ts";
import { createReviewPipeline } from "#src/review/review-pipeline.ts";

import { expectVerdict, makePipeline } from "../pipeline-helpers.ts";

// Count the underlying read, not the two wrappers over it: the spy sits on the
// one function that touches the disk.
vi.mock("#src/review/request/observed-facts.ts", async (importOriginal) => {
  const actual = await importOriginal<{ snapshotObservedFacts: typeof snapshotObservedFacts }>();
  return {
    ...actual,
    snapshotObservedFacts: vi.fn<typeof snapshotObservedFacts>(actual.snapshotObservedFacts),
  };
});

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

describe("single snapshot per review", () => {
  it("takes exactly one observed-facts snapshot per review", async () => {
    const cwd = makeTmp("single-snapshot");
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { migrate: "node a.js" } }));
    const authorize = createReviewPipeline(makePipeline({ cwd }));
    await expectVerdict(authorize, { value: "npm run migrate" }, { kind: "allow" }, "ask");
    expect(snapshotObservedFacts).toHaveBeenCalledTimes(1);
  });
});
