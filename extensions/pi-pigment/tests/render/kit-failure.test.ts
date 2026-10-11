/**
 * The kit-build fail-safe: a session_start whose kit build throws must
 * leave the instance's kit empty, so the resolver hands every name to the
 * next renderer (pi's built-ins) BY REFERENCE instead of decorating with a
 * stale or half-built session's kit — and the failure surfaces through the
 * documented issue channel (the TUI notification when one exists).
 *
 * The kit is per-extension-instance state (the SDK caches the extension
 * factory per cwd, so a pi-subagents child reuses the module instance);
 * both assertions therefore drive the public seams — the registered
 * resolver and the fired session boundaries — never the state itself.
 */

import type { ToolRenderers } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPigmentExtension } from "#src/extension.ts";
import type { createRenderKit as CreateRenderKit } from "#src/render/kit.ts";
import { DECORATABLE_NAMES, makeTestPi, type TestPi } from "#test/host.ts";

/** Kit-build call counter: the first build succeeds, later ones throw. */
const buildState = vi.hoisted(() => ({ calls: 0 }));

vi.mock("#src/render/kit.ts", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createRenderKit: (async (options: unknown) => {
      buildState.calls += 1;
      if (buildState.calls > 1) throw new Error("kit-build exploded");
      return (actual.createRenderKit as typeof CreateRenderKit)(options as never);
    }) as typeof CreateRenderKit,
  };
});

/** The built-in renderer triple a yield must hand back by reference. */
const ORIG: ToolRenderers = {
  renderShell: "default",
  renderCall: (() => ({ kind: "builtin-call" })) as never,
  renderResult: (() => ({ kind: "builtin-result" })) as never,
};

/** The context a fired session boundary carries. */
const CTX = {
  cwd: "/kit-failure-project",
  isProjectTrusted: () => true,
  hasUI: true,
  ui: { notify: vi.fn<() => void>() },
};

/**
 * Build a host and wire the extension into it.
 *
 * @returns The host (the caller fires the boundaries).
 */
function setUp(): TestPi {
  const host = makeTestPi();
  createPigmentExtension(host.api);
  return host;
}

/**
 * Fire the session_start boundary.
 *
 * @param host - The test host.
 */
async function start(host: TestPi): Promise<void> {
  await host.fire("session_start", { type: "session_start", reason: "startup" }, CTX);
}

beforeEach(() => {
  buildState.calls = 0;
  CTX.ui.notify.mockClear();
  delete process.env.PI_CODING_AGENT_DIR;
});

afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
});

describe("kit-build fail-safe", () => {
  it("clears the kit and yields every name when the kit build throws", async () => {
    const host = setUp();
    // First start builds; the rebuild then throws, and the prior kit must
    // not survive it.
    await start(host);
    const toolRendererResolver = host.resolver();
    if (toolRendererResolver === undefined) throw new Error("resolver not registered");
    expect(toolRendererResolver("bash", () => ORIG)).not.toBe(ORIG);

    await start(host);
    // The failure surfaces through the issue channel (ui.notify).
    expect(CTX.ui.notify).toHaveBeenCalledWith("[pi-pigment] kit-build exploded", "warning");
    // With the kit cleared the resolver falls through to next() for every name.
    for (const name of DECORATABLE_NAMES) expect(toolRendererResolver(name, () => ORIG)).toBe(ORIG);
  });

  it("clears the kit on session_shutdown — the other boundary", async () => {
    const host = setUp();
    await start(host);
    const toolRendererResolver = host.resolver();
    if (toolRendererResolver === undefined) throw new Error("resolver not registered");
    expect(toolRendererResolver("bash", () => ORIG)).not.toBe(ORIG);
    await host.fire("session_shutdown", { type: "session_shutdown", reason: "quit" }, CTX);
    for (const name of DECORATABLE_NAMES) expect(toolRendererResolver(name, () => ORIG)).toBe(ORIG);
  });
});
