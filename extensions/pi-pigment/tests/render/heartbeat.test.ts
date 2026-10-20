/** The pending-cell contract: wall-clock-bucketed, pending-gated, driver-safe. */

import { describe, expect, it } from "vitest";

import {
  armHeartbeat,
  clearHeartbeat,
  heartbeatFrame,
  heartbeatCell,
} from "#src/render/heartbeat.ts";
import type { RenderContext } from "#src/render/tool-services.ts";
import type { RenderTheme } from "#src/theme/scheme.ts";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

function pendingCtx(): RenderContext<object> {
  return { isPartial: true, isError: false, executionStarted: true } as RenderContext<object>;
}

function settledCtx(): RenderContext<object> {
  return { isPartial: false, isError: false } as RenderContext<object>;
}

const theme = { fg: (_slot: string, s: string) => s } as unknown as RenderTheme;

describe("heartbeatFrame", () => {
  it("maps the wall clock into 250ms buckets over the 10-frame cycle", () => {
    expect(heartbeatFrame(0)).toBe(FRAMES[0]);
    expect(heartbeatFrame(249)).toBe(FRAMES[0]);
    expect(heartbeatFrame(250)).toBe(FRAMES[1]);
    expect(heartbeatFrame(2500)).toBe(FRAMES[0]);
  });

  it("is idempotent inside one bucket (the anti-feedback-loop contract)", () => {
    expect(heartbeatFrame(1000)).toBe(heartbeatFrame(1001));
    expect(heartbeatFrame(1000)).toBe(heartbeatFrame(1249));
  });
});

describe("heartbeatCell", () => {
  it("shows the cell while pending, styled muted", () => {
    const styled = { fg: (slot: string, s: string) => `${slot}:${s}` } as unknown as RenderTheme;
    expect(heartbeatCell(pendingCtx(), styled, 0)).toBe(`muted:${FRAMES[0]}`);
  });

  it("is empty on settled and error frames", () => {
    expect(heartbeatCell(settledCtx(), theme, 0)).toBe("");
    const err = { isPartial: false, isError: true } as RenderContext<object>;
    expect(heartbeatCell(err, theme, 0)).toBe("");
  });

  it("is empty while args still stream (execution not yet started)", () => {
    const streaming = {
      isPartial: true,
      isError: false,
      executionStarted: false,
    } as RenderContext<object>;
    expect(heartbeatCell(streaming, theme, 0)).toBe("");
  });
});

describe("heartbeat driver", () => {
  it("arms once and sweeps idempotently", () => {
    const state: { heartbeatInterval?: ReturnType<typeof setInterval> } = {};
    let ticks = 0;
    armHeartbeat(state, () => {
      ticks += 1;
    });
    const first = state.heartbeatInterval;
    expect(first).toBeDefined();
    // Second arm is a no-op (no duplicate interval).
    armHeartbeat(state, () => {
      ticks += 100;
    });
    expect(state.heartbeatInterval).toBe(first);
    clearHeartbeat(state);
    expect(state.heartbeatInterval).toBeUndefined();
    expect(ticks).toBe(0);
    // Sweep without arming is safe.
    clearHeartbeat(state);
  });
});
