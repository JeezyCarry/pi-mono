/**
 * The extension assembly — the whole runtime wiring (the modules live
 * under src/{core,theme,config,render}).
 *
 * Rendering pipeline (like OpenTUI / delta): Shiki turns code into
 * fg-only ANSI → diff background colors layer underneath (composited at
 * cell level) → word-level changes get a brighter background at the
 * changed char positions. Syntax fg + diff bg + word emphasis, all three
 * visible together. Split (side-by-side) views serve write/edit and fall back
 * to unified (stacked) on narrow terminals or wrap-heavy hunks.
 *
 * Pi-pigment owns NO tools: it registers one `registerToolRenderer`
 * resolver (resolver.ts) that supplies renderCall/renderResult for the
 * built-in tool names, delegating execute and outcome to pi's own tools.
 * Each `session_start` (startup, reload, fork, resume) re-resolves the
 * two-layer config, builds the session kit, and publishes it to this
 * instance's kit (kit.ts) the resolver reads. The kit lives
 * in the extension closure — never module state — so a pi-subagents child
 * session reusing this module instance cannot overwrite or clear the
 * parent's kit. The write renderer's old/new diff
 * rides the tool_call/tool_result channel (write-details-channel.ts).
 *
 * Theming (ADR 0006): the bundled themes ship as package assets (pi's
 * manifest discovers themes/); resources_discover lists the user's
 * converted pigment-*.json outputs; `/pigment convert` does the manual
 * conversion. Rendering is zero-config: the scheme auto-derives from the
 * active pi theme and the syntax tokens follow the detection chain.
 */

import {
  type ExtensionContext,
  type ExtensionAPI,
  getAgentDir,
  type SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

import { registerPigmentCommand } from "#src/command/theme-command.ts";
import type { SessionEnv } from "#src/core/session-env.ts";
import { createRenderKit, type KitGetter, type RenderKit } from "#src/render/kit.ts";
import { registerPigmentToolRenderers } from "#src/render/resolver.ts";
import { registerWriteDetailsChannel } from "#src/render/write-details-channel.ts";
import { listConvertedThemes } from "#src/theme/user-themes.ts";

/**
 * Wire pi-pigment into the session: register the renderer resolver and the
 * write-details channel once, then rebuild the session kit on every
 * `session_start`. The bundled themes ship as package assets (pi's
 * manifest discovers themes/); the user's theme files convert at
 * resources_discover time.
 *
 * @param pi - The extension API.
 */
export function createPigmentExtension(pi: ExtensionAPI): void {
  // The instance's session state. The SDK caches the extension factory per
  // cwd, so a pi-subagents child session reuses this module instance: the
  // kit must live in this closure, never in module state, or the child's
  // session_start/session_shutdown would overwrite or clear the parent's.
  // This function is the only writer; the resolver and the channel below
  // receive a read-only getter.
  let currentKit: RenderKit | undefined;
  const getKit: KitGetter = () => currentKit;
  // The renderer resolver: registered once. It reads the live registry and
  // the instance's kit at call time, so no per-session re-registration is
  // needed (the SDK collects resolvers at extension load).
  registerPigmentToolRenderers(pi, getKit);
  // The write renderer's execution-side channel: the SDK's write tool
  // carries `details: undefined`, so the old/new diff is captured through
  // the tool_call/tool_result hooks. Strictly scoped to write.
  registerWriteDetailsChannel(pi, getKit);
  // Outside a session there is no kit. The build handler below always
  // assigns on `session_start` (kit or undefined), so only the shutdown
  // edge needs its own clear.
  pi.on("session_shutdown", () => {
    currentKit = undefined;
  });

  // The latest session_start environment: the `/pigment` completer's read
  // and the kit's own inputs, from one source.
  let sessionEnv: SessionEnv | undefined;
  pi.on("session_start", async (_event: SessionStartEvent, ctx: ExtensionContext) => {
    sessionEnv = { cwd: ctx.cwd, agentDir: getAgentDir() };
    // Config/theme issues surface through the documented channel — the
    // TUI notification area (or RPC client) when present; stderr only in
    // headless modes (print/json), where it is the visible medium.
    const reportIssue = (message: string): void => {
      if (ctx.hasUI) {
        ctx.ui.notify(`[pi-pigment] ${message}`, "warning");
      } else {
        console.error(`[pi-pigment] ${message}`);
      }
    };
    // The session's kit: the resolver builds every renderer triple from it.
    // A build failure clears it so the resolver fails safe to pi's own
    // rendering rather than decorating with a stale session's config.
    try {
      currentKit = await createRenderKit({ ...sessionEnv, reportIssue });
    } catch (error) {
      currentKit = undefined;
      reportIssue(error instanceof Error ? error.message : String(error));
    }
  });

  // The registration channel for converted user themes (ADR 0006): the
  // `/pigment convert` command writes outputs next to their sources; this
  // lists them (individual files — the directory also holds TextMate theme
  // sources pi must not load). Pure listing, zero conversion at startup.
  pi.on("resources_discover", async (_event, ctx: ExtensionContext) => {
    const outputs = listConvertedThemes({ cwd: ctx.cwd, agentDir: getAgentDir() });
    return outputs.length > 0 ? { themePaths: outputs } : {};
  });

  // Manual conversion: /pigment convert [stem] (TUI selector without one).
  registerPigmentCommand(pi, { getEnv: () => sessionEnv });
}
