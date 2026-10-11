/**
 * Session isolation: two `createPigmentExtension` calls in one process (the
 * pi-subagents shape — the SDK caches the extension factory per cwd, so a
 * child session reuses the parent's module instance) must not share render
 * state. A child's session_start/session_shutdown must leave the parent's
 * resolver decorating, and its write stashes must not resolve on the
 * parent's channel.
 */

import type { ToolRenderers } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";

import { createPigmentExtension } from "#src/extension.ts";
import { DECORATABLE_NAMES, makeTestPi, type TestPi } from "#test/host.ts";

/** The built-in renderer triple a yield must hand back by reference. */
const ORIG: ToolRenderers = {
  renderShell: "default",
  renderCall: (() => ({ kind: "builtin-call" })) as never,
  renderResult: (() => ({ kind: "builtin-result" })) as never,
};

/**
 * A session boundary context for `cwd`.
 *
 * @param cwd - The session working directory.
 * @returns The minimal context the extension reads.
 */
function sessionCtx(cwd: string): unknown {
  return {
    cwd,
    isProjectTrusted: () => true,
    hasUI: true,
    ui: { notify: () => {} },
  };
}

/**
 * Start a session on `host`, as pi's startup would.
 *
 * @param host - The test host.
 * @param cwd - The session working directory.
 */
async function start(host: TestPi, cwd: string): Promise<void> {
  await host.fire("session_start", { type: "session_start", reason: "startup" }, sessionCtx(cwd));
}

beforeEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
});

describe("session isolation across extension instances", () => {
  it("a child session_start/session_shutdown leaves the parent resolver decorating", async () => {
    // The SDK caches the extension factory per cwd: parent and child
    // sessions run the SAME module instance — reproduced here by calling
    // the factory twice in one process.
    const parent = makeTestPi();
    const child = makeTestPi();
    createPigmentExtension(parent.api);
    createPigmentExtension(child.api);

    await start(parent, "/parent");
    const resolveParent = parent.resolver();
    if (resolveParent === undefined) throw new Error("parent resolver not registered");
    // Parent decorates before the child ever starts.
    expect(resolveParent("bash", () => ORIG)).not.toBe(ORIG);

    // The child session starts (same process, same module instance).
    await start(child, "/child");
    // The parent's resolver must still decorate with the PARENT kit.
    expect(resolveParent("bash", () => ORIG)).not.toBe(ORIG);

    // The child session ends: its boundary clear must not empty the parent kit.
    await child.fire(
      "session_shutdown",
      { type: "session_shutdown", reason: "quit" },
      sessionCtx("/child"),
    );
    for (const name of DECORATABLE_NAMES) expect(resolveParent(name, () => ORIG)).not.toBe(ORIG);
  });

  it("a child's stashes never leak into the parent channel", async () => {
    const parent = makeTestPi();
    const child = makeTestPi();
    createPigmentExtension(parent.api);
    createPigmentExtension(child.api);

    await start(parent, "/parent");
    await start(child, "/child");

    // A write stashed on the child instance must not resolve on the parent:
    // the parent's tool_result for the same toolCallId invents nothing.
    const writeInput = { path: "x.ts", content: "child\n" };
    await child.fire(
      "tool_call",
      { type: "tool_call", toolName: "write", toolCallId: "shared-id", input: writeInput },
      sessionCtx("/child"),
    );
    const [leaked] = await parent.fire(
      "tool_result",
      {
        type: "tool_result",
        toolName: "write",
        toolCallId: "shared-id",
        input: writeInput,
        content: [],
        isError: false,
      },
      sessionCtx("/parent"),
    );
    expect(leaked).toBeUndefined();
  });
});
