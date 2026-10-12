/**
 * The pending-frame heartbeat: a braille spinner cell (`· ⠋`) trailing
 * the header while a tool call is still pending, proving the TUI's
 * render loop is alive. The cell proves the loop runs, never that the
 * model streams — a provider stall with an idling TUI keeps spinning
 * (ADR 0005).
 *
 * The frame is a pure function of the wall clock (one glyph per 250ms
 * bucket), never a per-render counter: a counter would change the header
 * key on every renderCall, and the preview task's own commit re-runs
 * renderCall — a self-driving repaint loop disguised as the feature.
 */

import type { RenderTheme } from "#src/theme/scheme.ts";

import { callStateOf, type RenderContext } from "./tool-services.ts";

/**
 * One spinner cycle: mirrors pi-tui Loader's own DEFAULT_FRAMES (kept
 * in sync by hand — upstream does not export it).
 */
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** One frame's dwell (4Hz). */
const FRAME_MS = 250;

/** The render-state slot the pending driver lives in. */
export interface HeartbeatState {
  /** The pending driver's interval (undefined when not pending). */
  heartbeatInterval?: ReturnType<typeof setInterval>;
}

/**
 * The braille frame of the current 250ms bucket. Same bucket, same glyph
 * — so the header key stays put within a bucket and the preview task
 * converges instead of re-arming forever.
 *
 * @param now - The wall-clock time (Date.now() at the call site — injected for tests).
 * @returns The frame glyph.
 */
export function heartbeatFrame(now: number): string {
  return FRAMES[Math.floor(now / FRAME_MS) % FRAMES.length] ?? "";
}

/**
 * The pending heartbeat cell: the muted glyph while the execution is
 * live, "" otherwise. Shows only while pending AND executionStarted —
 * the args-streaming window belongs to the assistant's own stream, and
 * settled/error frames and session replays show none.
 *
 * @param ctx - The render context (the pending gate's input).
 * @param theme - The pi theme (the muted slot).
 * @param now - The wall-clock time.
 * @returns The styled cell, or "".
 */
export function heartbeatCell(ctx: RenderContext<object>, theme: RenderTheme, now: number): string {
  if (callStateOf(ctx) !== "pending" || !ctx.executionStarted) return "";
  return theme.fg("muted", heartbeatFrame(now));
}

/**
 * Arm the pending driver: a ~4Hz row invalidate so quiet periods (no tool
 * events) still advance the buckets. Swept on every final frame.
 *
 * @param state - The renderer's render state (the interval's home).
 * @param invalidate - The row's invalidate (ctx.invalidate).
 */
export function armHeartbeat(state: HeartbeatState, invalidate: () => void): void {
  if (state.heartbeatInterval !== undefined) return;
  const interval = setInterval(invalidate, FRAME_MS);
  // A row dropped without a settled frame must not pin the event loop.
  interval.unref?.();
  state.heartbeatInterval = interval;
}

/**
 * Sweep the driver. Idempotent: safe on paths that never armed.
 *
 * @param state - The renderer's render state.
 */
export function clearHeartbeat(state: HeartbeatState): void {
  if (state.heartbeatInterval !== undefined) {
    clearInterval(state.heartbeatInterval);
    state.heartbeatInterval = undefined;
  }
}
