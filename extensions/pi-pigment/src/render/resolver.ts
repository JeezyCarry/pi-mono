/**
 * The renderer resolver: how pi-pigment's rendering reaches the TUI
 * without pi-pigment owning a single tool.
 *
 * Pi collects `registerToolRenderer` resolvers at extension load and runs
 * them in load order for every tool call, each passing the next resolver
 * (then the built-in renderers) as `next()`. pi-pigment registers exactly
 * one resolver, once. It never registers a tool, never occupies a name,
 * and never touches execution.
 *
 * The ordered yield rules live in the gate module (`gate.kitToDecorate`),
 * so this file only owns the delegate-or-decorate step:
 *
 * 1. The gate yields the name (no kit yet before the first `session_start` or after a failed build; an
 *    unknown name; a name another extension owns; pi-fff present for grep/find; or a name in
 *    `disabledTools`) → `next()` (fail-safe to pi's own rendering);
 * 2. The gate returns the kit → build the renderer triple over `next()`, falling back to it when the
 *    build throws.
 *
 * The kit is read per call from the instance's kit (kit.ts), which this
 * instance's `session_start` builds; a resume/fork re-fire simply swaps
 * the kit, so the same resolver serves every session — and one process can
 * hold several instances (parent + subagent children) without their kits
 * colliding.
 */

import type {
  ExtensionAPI,
  ToolRendererResolver,
  ToolRenderers,
} from "@earendil-works/pi-coding-agent";

import { kitToDecorate } from "./gate.ts";
import type { KitGetter } from "./kit.ts";

/**
 * Build the resolver closure over `pi` (the live registry surface the
 * yield gates read) and the instance's read-only kit getter.
 *
 * The registry snapshot (`getAllTools`/`getCommands`) is taken per call,
 * never cached: pi exposes no registry revision to key a cache on, so a
 * cache could serve a stale yield — the very failure ADR 0005 exists to
 * prevent. The cost is one snapshot array per tool call, sub-microsecond
 * against the tool's own execution.
 *
 * @param pi - The extension API.
 * @param getKit - The extension instance's read-only kit getter.
 * @returns The tool renderer resolver.
 */
export function createPigmentToolRendererResolver(
  pi: ExtensionAPI,
  getKit: KitGetter,
): ToolRendererResolver {
  return (toolName: string, next: () => ToolRenderers | undefined): ToolRenderers | undefined => {
    const kit = kitToDecorate(pi, getKit(), toolName);
    if (kit === undefined) return next();
    // Resolve the chain once, then compose over it. A throw from our own
    // factories returns the resolved value untouched: pi's
    // resolveToolRenderers has no try/catch, so an escaping throw would
    // surface as an unhandled exception in the TUI's render dispatch.
    const orig = next();
    try {
      return kit.renderersFor(toolName, orig);
    } catch {
      return orig;
    }
  };
}

/**
 * Register the resolver. Called once at extension load.
 *
 * @param pi - The extension API.
 * @param getKit - The extension instance's read-only kit getter.
 */
export function registerPigmentToolRenderers(pi: ExtensionAPI, getKit: KitGetter): void {
  pi.registerToolRenderer(createPigmentToolRendererResolver(pi, getKit));
}
