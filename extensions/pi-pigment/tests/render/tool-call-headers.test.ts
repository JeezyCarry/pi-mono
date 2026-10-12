/**
 * ALL tools' call-header rendering, pinned through the ToolDefinition
 * interface (renderCall) — the seam the TUI itself drives. Two invariants
 * hold for every header:
 *
 * 1. The trailing blank follows the call state (renderHeaderLine's default): pending frames end
 *    without "\n" (the shell padding supplies the gap), settled frames end with one.
 *    Bash/powershell are the exception: their headers never separate (the native result renderer
 *    owns the layout below).
 * 2. The header echoes the key args (the settled-args contract: args are present every frame, live and
 *    restored alike).
 */
import { describe, expect, it, vi } from "vitest";

import {
  buildRenderTheme,
  makeRenderCtx,
  plain,
  registerTools,
  resetPigmentForTest,
  toolOf,
} from "#test/fixtures.ts";

/**
 * Render one header frame, plain-text.
 *
 * @param name - The tool name.
 * @param args - The call args.
 * @param isPartial - The pending state.
 * @returns The plain header text.
 */
async function headerText(name: string, args: unknown, isPartial: boolean): Promise<string> {
  resetPigmentForTest();
  const tools = await registerTools();
  const tool = toolOf(tools, name);
  const { ctx } = makeRenderCtx();
  ctx.args = args;
  ctx.isPartial = isPartial;
  const component = tool.renderCall!(args, buildRenderTheme(), ctx as never) as {
    text: { text: string };
  };
  return plain(component.text.text);
}

/**
 * Render one header frame with the execution live (the TUI's own gate:
 * pending AND executionStarted) under a frozen wall clock.
 *
 * @param name - The tool name.
 * @param args - The call args.
 * @param partial - The pending state.
 * @param now - The frozen wall-clock time.
 * @returns The plain header text and the render state.
 */
async function liveHeader(name: string, args: unknown, partial: boolean, now: number) {
  resetPigmentForTest();
  const tools = await registerTools();
  const tool = toolOf(tools, name);
  const { ctx } = makeRenderCtx();
  ctx.args = args;
  ctx.isPartial = partial;
  ctx.executionStarted = true;
  vi.useFakeTimers();
  vi.setSystemTime(now);
  try {
    const component = tool.renderCall!(args, buildRenderTheme(), ctx as never) as {
      text: { text: string };
    };
    return { text: plain(component.text.text), state: ctx.state };
  } finally {
    vi.useRealTimers();
  }
}

describe("tool call headers", () => {
  const cases: { name: string; args: unknown; marker: string; settledBlank: boolean }[] = [
    { name: "read", args: { path: "src/a.ts" }, marker: "src/a.ts", settledBlank: true },
    {
      name: "write",
      args: { path: "src/a.ts", content: "x" },
      marker: "src/a.ts",
      settledBlank: true,
    },
    {
      name: "edit",
      args: { path: "src/a.ts", edits: [] },
      marker: "src/a.ts",
      settledBlank: true,
    },
    {
      name: "grep",
      args: { pattern: "foo", path: "src" },
      marker: "/foo/",
      settledBlank: true,
    },
    {
      name: "find",
      args: { pattern: "*.ts", path: "src" },
      marker: "*.ts",
      settledBlank: true,
    },
    { name: "ls", args: { path: "src" }, marker: "src", settledBlank: true },
    { name: "bash", args: { command: "ls -la" }, marker: "ls -la", settledBlank: false },
    {
      name: "powershell",
      args: { command: "Get-ChildItem" },
      marker: "Get-ChildItem",
      settledBlank: false,
    },
  ];

  for (const { name, args, marker, settledBlank } of cases) {
    it(`${name} echoes its key args`, async () => {
      expect(await headerText(name, args, false)).toContain(marker);
    });

    it(`${name} pending owns no trailing blank`, async () => {
      expect((await headerText(name, args, true)).endsWith("\n")).toBe(false);
    });

    it(`${name} settled ${settledBlank ? "keeps" : "skips"} its separator blank`, async () => {
      expect((await headerText(name, args, false)).endsWith("\n")).toBe(settledBlank);
    });
  }

  const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  it("the pending header carries the wall-clock frame and arms its driver", async () => {
    const { text, state } = await liveHeader("read", { path: "src/a.ts" }, true, 0);
    // The cell trails the body in the settled `· ✓` slot, so the `$`
    // keeps column 0 and the body's left edge never moves.
    expect(text).toContain(`· ${FRAMES[0]}`);
    // The 250ms driver is armed on the tool's state (swept on settle).
    expect((state as { heartbeatInterval?: unknown }).heartbeatInterval).toBeDefined();
  });

  it("the frame follows the wall clock, not the render count", async () => {
    const a = await liveHeader("read", { path: "src/a.ts" }, true, 0);
    const b = await liveHeader("read", { path: "src/a.ts" }, true, 250);
    expect(a.text).toContain(`· ${FRAMES[0]}`);
    expect(b.text).toContain(`· ${FRAMES[1]}`);
  });

  it("re-renders inside one bucket are byte-identical (the loop-convergence contract)", async () => {
    // The preview task's own commit calls invalidate() -> updateDisplay() ->
    // renderCall again; if a re-render inside the same 250ms bucket changed
    // the header, the task would re-arm forever. Same bucket, same bytes.
    const a = await liveHeader("read", { path: "src/a.ts" }, true, 0);
    const b = await liveHeader("read", { path: "src/a.ts" }, true, 10);
    expect(a.text).toBe(b.text);
  });

  it("a settled header carries no frame and no driver", async () => {
    const { text, state } = await liveHeader("read", { path: "src/a.ts" }, false, 0);
    expect(FRAMES.some((f) => text.includes(`· ${f}`))).toBe(false);
    expect((state as { heartbeatInterval?: unknown }).heartbeatInterval).toBeUndefined();
  });

  it("a bucket flip re-arms the placeholder at the committed width (no cut-shift)", async () => {
    // The placeholder must re-arm at the width the committed frame used,
    // so a bucket flip re-cuts nothing: same body, only the trailing
    // glyph changes.
    resetPigmentForTest();
    const tools = await registerTools();
    const tool = toolOf(tools, "read");
    const { ctx } = makeRenderCtx();
    const longPath = `src/${"deep-directory/".repeat(5)}file-name-here.ts`;
    ctx.args = { path: longPath };
    ctx.isPartial = true;
    ctx.executionStarted = true;
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      const component = tool.renderCall!(ctx.args, buildRenderTheme(), ctx) as {
        text: { text: string };
        previewLastWidth?: number;
        render(width: number): string[];
      };
      component.render(40);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const committed = plain(component.text.text).split("\n")[0];
      expect(committed).toContain("…");
      expect(component.previewLastWidth).toBe(40);
      // Next bucket: re-arm with the same args; the placeholder must cut
      // at 40 too (not termW()), so only the glyph changes.
      now.mockReturnValue(250);
      tool.renderCall!(ctx.args, buildRenderTheme(), ctx);
      const placeholder = plain(component.text.text).split("\n")[0];
      // Same trailing cell, same cut: everything before the cell is
      // byte-identical (the placeholder did not re-cut at another width).
      const cell0 = `· ${FRAMES[0]}`;
      const cell1 = `· ${FRAMES[1]}`;
      expect(placeholder.endsWith(cell1)).toBe(true);
      expect(placeholder.slice(0, -cell1.length)).toBe(committed.slice(0, -cell0.length));
    } finally {
      now.mockRestore();
    }
  });
});
