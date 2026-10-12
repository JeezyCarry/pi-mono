/**
 * The write-details channel: the tool_call/tool_result pair that captures
 * the old/new diff the SDK's write tool does not carry. The self-check is
 * the contract under test — details are produced ONLY when the file that
 * landed is exactly the content the call supplied, so a sibling write, a
 * changed argument, an aborted call, or a blocked one degrades to no
 * details (the renderer then falls back to the plain line).
 */

import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRenderKit, type KitGetter, type RenderKit } from "#src/render/kit.ts";
import { registerWriteDetailsChannel } from "#src/render/write-details-channel.ts";
import { makeTestPi, type TestPi } from "#test/host.ts";
import { vol, writeFile } from "#test/memfs.ts";

vi.mock("node:fs");
vi.mock("fs");
vi.mock("node:fs/promises");
vi.mock("fs/promises");

const CWD = "/wd-project";
const AGENT = "/wd-agent";

/** The kit the channel reads; `kit` mirrors the extension's write point. */
let kit: RenderKit | undefined;
const getKit: KitGetter = () => kit;

/**
 * Build a host with the channel registered over the current kit.
 *
 * @param foreignTools - Tool names another extension already owns.
 * @returns The host.
 */
function setUp(foreignTools: string[] = []): TestPi {
  const host = makeTestPi({ foreignTools });
  registerWriteDetailsChannel(host.api, getKit);
  return host;
}

/**
 * The `tool_call` payload for a write.
 *
 * @param id - The tool call id.
 * @param input - The write tool input.
 * @returns The event payload.
 */
function callPayload(id: string, input: Record<string, unknown>): Record<string, unknown> {
  return { type: "tool_call", toolName: "write", toolCallId: id, input };
}

/**
 * The `tool_result` payload for a write.
 *
 * @param id - The tool call id.
 * @param input - The write tool input.
 * @param isError - Whether the call failed.
 * @returns The event payload.
 */
function resultPayload(
  id: string,
  input: Record<string, unknown>,
  isError = false,
): Record<string, unknown> {
  return { type: "tool_result", toolName: "write", toolCallId: id, input, content: [], isError };
}

beforeEach(async () => {
  vol.reset();
  vol.mkdirSync(CWD, { recursive: true });
  vol.mkdirSync(AGENT, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = AGENT;
  kit = await createRenderKit({ cwd: CWD, agentDir: AGENT });
});

afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  vol.reset();
});

describe("write details channel", () => {
  it("captures a changed-file diff when the landed content matches", async () => {
    writeFile(join(CWD, "a.ts"), "const a = 1;\n");
    const host = setUp();
    const input = { path: "a.ts", content: "const a = 2;\n" };
    await host.fire("tool_call", callPayload("c1", input));
    writeFile(join(CWD, "a.ts"), "const a = 2;\n");
    const [result] = (await host.fire("tool_result", resultPayload("c1", input))) as Array<{
      details?: { kind?: string };
    }>;
    expect(result?.details?.kind).toBe("diff");
  });

  it("captures a new file", async () => {
    const host = setUp();
    const input = { path: "new.ts", content: "export const x = 1;\n" };
    await host.fire("tool_call", callPayload("c2", input));
    writeFile(join(CWD, "new.ts"), "export const x = 1;\n");
    const [result] = (await host.fire("tool_result", resultPayload("c2", input))) as Array<{
      details?: { kind?: string };
    }>;
    expect(result?.details?.kind).toBe("new");
  });

  it("captures no-change", async () => {
    writeFile(join(CWD, "same.ts"), "same\n");
    const host = setUp();
    const input = { path: "same.ts", content: "same\n" };
    await host.fire("tool_call", callPayload("c3", input));
    const [result] = (await host.fire("tool_result", resultPayload("c3", input))) as Array<{
      details?: { kind?: string };
    }>;
    expect(result?.details?.kind).toBe("noChange");
  });

  it("drops details when the disk content differs from what the call supplied (changed args)", async () => {
    writeFile(join(CWD, "race.ts"), "old\n");
    const host = setUp();
    const input = { path: "race.ts", content: "expected\n" };
    await host.fire("tool_call", callPayload("c4", input));
    // A sibling/rewritten write landed a different body.
    writeFile(join(CWD, "race.ts"), "something else\n");
    const [result] = await host.fire("tool_result", resultPayload("c4", input));
    expect(result).toBeUndefined();
  });

  it("reads the content from the result event's args, so an in-place mutation is observed", async () => {
    // The tool_call sees A; another tool_call handler mutates the args in
    // place to B before execution, so the result event carries B and the
    // file lands B. The diff must be old -> B (not dropped against the
    // stale A snapshot).
    writeFile(join(CWD, "mutated.ts"), "old\n");
    const host = setUp();
    await host.fire("tool_call", callPayload("cm", { path: "mutated.ts", content: "A\n" }));
    writeFile(join(CWD, "mutated.ts"), "B\n");
    const [result] = (await host.fire(
      "tool_result",
      resultPayload("cm", { path: "mutated.ts", content: "B\n" }),
    )) as Array<{ details?: { kind?: string } }>;
    expect(result?.details?.kind).toBe("diff");
  });

  it("drops details on an error result", async () => {
    writeFile(join(CWD, "err.ts"), "old\n");
    const host = setUp();
    const input = { path: "err.ts", content: "new\n" };
    await host.fire("tool_call", callPayload("c5", input));
    writeFile(join(CWD, "err.ts"), "new\n");
    const [result] = await host.fire("tool_result", resultPayload("c5", input, true));
    expect(result).toBeUndefined();
  });

  it("drops details for a blocked call (tool_call with no tool_result, or no stash)", async () => {
    writeFile(join(CWD, "blocked.ts"), "old\n");
    const host = setUp();
    // No tool_call ever fired (blocked before execution): a stray
    // tool_result must not invent details.
    const [result] = await host.fire(
      "tool_result",
      resultPayload("c6", { path: "blocked.ts", content: "x" }),
    );
    expect(result).toBeUndefined();
  });

  it("never throws out of tool_call — a registry fault must not block the write", async () => {
    // pi's emitToolCall has no guard, and the SDK wraps a handler throw as
    // "Extension failed, blocking execution" — so a rendering-side fault
    // here would stop the model's write from ever running. The handler must
    // swallow every throw and leave the caller with nothing to block on.
    writeFile(join(CWD, "boom.ts"), "old\n");
    const host = setUp();
    (host.api as { getAllTools: () => unknown }).getAllTools = () => {
      throw new Error("registry exploded");
    };
    const input = { path: "boom.ts", content: "new\n" };
    await expect(host.fire("tool_call", callPayload("c7", input))).resolves.toBeDefined();
    // The fault dropped the stash, so the paired result invents nothing.
    const [result] = await host.fire("tool_result", resultPayload("c7", input));
    expect(result).toBeUndefined();
  });

  it("stops stashing once write is disabled", async () => {
    kit = await createRenderKit({
      cwd: CWD,
      agentDir: AGENT,
      config: { disabledTools: ["write"] },
    });
    writeFile(join(CWD, "disabled.ts"), "old\n");
    const host = setUp();
    const input = { path: "disabled.ts", content: "new\n" };
    await host.fire("tool_call", callPayload("c7", input));
    writeFile(join(CWD, "disabled.ts"), "new\n");
    const [result] = await host.fire("tool_result", resultPayload("c7", input));
    expect(result).toBeUndefined();
  });

  it("stops stashing when another extension owns write", async () => {
    writeFile(join(CWD, "foreign.ts"), "old\n");
    const host = setUp(["write"]);
    const input = { path: "foreign.ts", content: "new\n" };
    await host.fire("tool_call", callPayload("c8", input));
    writeFile(join(CWD, "foreign.ts"), "new\n");
    const [result] = await host.fire("tool_result", resultPayload("c8", input));
    expect(result).toBeUndefined();
  });

  it("drops the stash on a session boundary between tool_call and tool_result", async () => {
    const host = setUp();
    // The pre-read lands, then the session ends before the tool_result
    // fires: each boundary must drop the stash, so a call straddling
    // either edge never leaks details into the next session.
    await host.fire("tool_call", callPayload("c9", { path: "boundary-a.ts", content: "one\n" }));
    writeFile(join(CWD, "boundary-a.ts"), "one\n");
    await host.fire("session_shutdown", {});
    const [afterShutdown] = await host.fire(
      "tool_result",
      resultPayload("c9", { path: "boundary-a.ts", content: "one\n" }),
    );
    expect(afterShutdown).toBeUndefined();

    await host.fire("tool_call", callPayload("c10", { path: "boundary-b.ts", content: "two\n" }));
    writeFile(join(CWD, "boundary-b.ts"), "two\n");
    await host.fire("session_start", {});
    const [afterStart] = await host.fire(
      "tool_result",
      resultPayload("c10", { path: "boundary-b.ts", content: "two\n" }),
    );
    expect(afterStart).toBeUndefined();
  });

  it("evicts the oldest stash once 16 in-flight calls are buffered", async () => {
    const host = setUp();
    // 16 in-flight writes (no tool_result yet), each landed on disk.
    const ids = Array.from({ length: 16 }, (_, i) => `c-fifo-${i}`);
    for (const [i, id] of ids.entries()) {
      await host.fire(
        "tool_call",
        callPayload(id, { path: `fifo-${i}.ts`, content: `content-${i}\n` }),
      );
      writeFile(join(CWD, `fifo-${i}.ts`), `content-${i}\n`);
    }
    // The 17th distinct id pushes the oldest entry (c-fifo-0) out.
    await host.fire(
      "tool_call",
      callPayload("c-fifo-16", { path: "fifo-16.ts", content: "content-16\n" }),
    );
    writeFile(join(CWD, "fifo-16.ts"), "content-16\n");

    // The evicted id has no stash left, so its result produces nothing...
    const [evicted] = await host.fire(
      "tool_result",
      resultPayload("c-fifo-0", { path: "fifo-0.ts", content: "content-0\n" }),
    );
    expect(evicted).toBeUndefined();
    // ...while the most recent call still resolves to a real payload.
    const [kept] = (await host.fire(
      "tool_result",
      resultPayload("c-fifo-16", { path: "fifo-16.ts", content: "content-16\n" }),
    )) as Array<{
      details?: { kind?: string };
    }>;
    expect(kept?.details?.kind).toBe("new");
  });
});
