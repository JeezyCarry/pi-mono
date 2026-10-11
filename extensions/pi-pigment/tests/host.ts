/**
 * The test host: one mock `pi` adapter shared by every suite that drives
 * the extension's registrations. A suite hands `api` to
 * `createPigmentExtension`, then replays the events pi would fire and reads
 * back what was registered — so the tests exercise the extension's real
 * handlers instead of each re-implementing the SDK surface (the four
 * hand-rolled hosts this replaces had drifted apart).
 *
 * The adapter speaks only the surface the extension actually uses:
 * `on`, `registerToolRenderer`, `registerCommand`, `getAllTools`,
 * `getCommands`. Member shapes are declared precisely so SDK drift fails
 * at compile time; the crossing into the SDK's full `ExtensionAPI` narrows
 * to one boundary cast.
 */

import type { ExtensionAPI, ToolRendererResolver } from "@earendil-works/pi-coding-agent";

/** One captured event handler (session and tool events alike). */
export type MockEventHandler = (event: Record<string, unknown>, ctx?: unknown) => unknown;

/** The eight decoratable names — the builtin registry the presence gates read. */
export const DECORATABLE_NAMES = [
  "write",
  "edit",
  "bash",
  "powershell",
  "grep",
  "ls",
  "find",
  "read",
] as const;

/** The mock `pi` surface. */
interface MockPiApi {
  on: (event: string, handler: MockEventHandler) => void;
  registerToolRenderer: (resolver: ToolRendererResolver) => void;
  registerCommand: (name: string, options: unknown) => void;
  getAllTools: () => Array<{ name: string; sourceInfo: { source: string; path: string } }>;
  getCommands: () => Array<{ name: string; sourceInfo?: { source: string } }>;
}

/** Options for {@link makeTestPi}. */
export interface TestPiOptions {
  /**
   * Foreign-owned tool names staged above the builtins. They carry source
   * "local" — the source extension TOOLS get in the real loader
   * (`claimedByOther` only reads `!== "builtin"`, so either local or
   * temporary exercises it; "local" is the faithful one).
   */
  foreignTools?: readonly string[];
  /** Extra command names, after the always-present `/pigment`. */
  foreignCommands?: readonly string[];
}

/** The host a suite drives. */
export interface TestPi {
  /** The API handed to `createPigmentExtension` (narrowed at the SDK boundary). */
  readonly api: ExtensionAPI;
  /**
   * The handlers registered for `event`, in registration order.
   *
   * @param event - The event name.
   * @returns The captured handlers (empty when none registered).
   */
  handlers(event: string): readonly MockEventHandler[];
  /**
   * Fire every `event` handler in order, awaiting each — pi's own dispatch.
   *
   * @param event - The event name.
   * @param payload - The event payload.
   * @param ctx - The session context (for session/tool events).
   * @returns The handlers' return values, in order.
   */
  fire(event: string, payload: Record<string, unknown>, ctx?: unknown): Promise<unknown[]>;
  /** The resolver the extension registered at load, if any. */
  resolver(): ToolRendererResolver | undefined;
}

/**
 * Build one mock `pi` host.
 *
 * @param options - Registry staging (foreign tools/commands).
 * @returns The host.
 */
export function makeTestPi(options: TestPiOptions = {}): TestPi {
  const foreignTools = options.foreignTools ?? [];
  const foreignCommands = options.foreignCommands ?? [];
  const handlers = new Map<string, MockEventHandler[]>();
  let toolRendererResolver: ToolRendererResolver | undefined;

  const api: MockPiApi = {
    on: (event: string, handler: MockEventHandler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerToolRenderer: (resolver: ToolRendererResolver) => {
      toolRendererResolver = resolver;
    },
    registerCommand: () => {},
    // The presence surfaces the yield gates read: foreign names under the
    // neighbor's path, the eight builtins with source "builtin" (a builtin
    // name alone never triggers a yield).
    getAllTools: () => [
      ...foreignTools.map((name) => ({
        name,
        sourceInfo: { source: "local", path: "/foreign-extension" },
      })),
      ...DECORATABLE_NAMES.map((name) => ({
        name,
        sourceInfo: { source: "builtin", path: `<builtin:${name}>` },
      })),
    ],
    // The /pigment command registers at factory time (before any
    // session_start).
    getCommands: () => [
      { name: "pigment", sourceInfo: { source: "extension" } },
      ...foreignCommands.map((name) => ({ name })),
    ],
  };

  return {
    api: api as unknown as ExtensionAPI,
    handlers: (event: string) => handlers.get(event) ?? [],
    fire: async (
      event: string,
      payload: Record<string, unknown>,
      ctx?: unknown,
    ): Promise<unknown[]> => {
      const results: unknown[] = [];
      for (const handler of handlers.get(event) ?? []) results.push(await handler(payload, ctx));
      return results;
    },
    resolver: () => toolRendererResolver,
  };
}
