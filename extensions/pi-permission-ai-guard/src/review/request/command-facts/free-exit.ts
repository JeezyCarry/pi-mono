/**
 * The closed free-exit shapes: a build-output delete and a project routine are
 * the only commands whose result the link may skip asking about without a
 * model. Both are closed by construction — anything the reader cannot spell
 * reads `none`, which is the conservative side.
 */
import { BUILD_NAMES, type PathResolver } from "./scope.ts";
import type { Arg, FactsContext, Invocation, PathScope } from "./types.ts";

/** The removal flag spellings the closed build-output shapes accept. */
const DELETE_FLAGS = new Set(["-r", "-R", "-f", "-rf", "-fr", "-Rf", "--recursive", "--force"]);

/** Bundled short removal flags: any combination of the four letters. */
const SHORT_REMOVAL_FLAGS = /^-[rRfv]+$/;

/** Long removal flags that do not change what the removal reaches. */
const LONG_REMOVAL_FLAGS = new Set(["--recursive", "--force", "--verbose"]);

/**
 * Whether one word is an acceptable argument to a removal in the free-exit
 * shape. Flags are a closed set — a removal whose behaviour the closed set
 * cannot spell (`--no-preserve-root`, `--one-file-system`, `-i`) reads false —
 * while a plain path word and the bare end-of-options `--` always pass.
 *
 * @param word - The argument word.
 * @returns True when the word leaves the removal's reach unchanged.
 */
export function allowedRemovalWord(word: string): boolean {
  if (!word.startsWith("-") || word === "-" || word === "--") return true;
  return SHORT_REMOVAL_FLAGS.test(word) || LONG_REMOVAL_FLAGS.has(word);
}

/**
 * Whether a `find` invocation's `-exec` clause is exactly one build-output
 * removal. The clause licenses the free exit, so it is matched with argument
 * count exactness rather than by inspection: `-exec`, then `rm`, then one
 * accepted removal flag, then `{}`, then `+`, and nothing after. A different
 * command, a different flag set, `-execdir`, `;`-termination or any trailing
 * argument reads false — and false is the conservative side.
 *
 * @param args - The `find` invocation's argument words.
 * @returns True only for the closed `-exec rm <flag> {} +` tail.
 */
export function execDeletesBuildOutput(args: readonly Arg[]): boolean {
  const at = args.findIndex((a) => a.text === "-exec");
  if (at < 0) return false;
  const tail = args.slice(at + 1).map((a) => a.text);
  return (
    tail.length === 4 &&
    tail[0] === "rm" &&
    DELETE_FLAGS.has(tail[1] ?? "") &&
    tail[2] === "{}" &&
    tail[3] === "+"
  );
}
/** How a runner names its project tasks. Entries are data: extending to a new ecosystem adds a row. */
interface RoutineRunner {
  readonly names: readonly string[];
  /** Task names (first positional argument, or the one after `run`) that count as routine. */
  readonly tasks: readonly string[];
  /** Accept an explicit `run` word before the task. */
  readonly allowRun?: boolean;
  /** The task body must be present in `FactsContext.declaredTasks` and free of risky verbs. */
  readonly declared?: boolean;
}

const CORE_TASKS = ["test", "build", "lint", "check", "format", "typecheck"] as const;
const ROUTINE_RUNNERS: readonly RoutineRunner[] = [
  {
    names: ["npm", "pnpm", "yarn", "bun"],
    tasks: [...CORE_TASKS, "dev", "start"],
    allowRun: true,
    declared: true,
  },
  { names: ["make", "just", "task", "ninja"], tasks: CORE_TASKS },
  { names: ["cargo"], tasks: ["test", "check", "build", "clippy", "fmt", "bench"] },
  { names: ["go"], tasks: ["test", "build", "vet"] },
  { names: ["mvn"], tasks: ["test", "verify", "compile", "package"] },
  { names: ["gradle"], tasks: ["test", "build", "check", "assemble"] },
  { names: ["dotnet"], tasks: ["test", "build"] },
  { names: ["mix"], tasks: ["test", "compile", "format"] },
  { names: ["bundle", "rake"], tasks: ["test", "spec", "rubocop"] },
];
/** Tools whose only job is to build, test, lint or format; run directly or through a launcher. */
const ROUTINE_TOOLS = new Set([
  "vite",
  "vitest",
  "jest",
  "tsc",
  "eslint",
  "oxlint",
  "prettier",
  "biome",
  "pytest",
  "ruff",
  "mypy",
  "black",
  "flake8",
  "tox",
  "nox",
  "rspec",
  "rubocop",
  "phpunit",
  "ctest",
  "cmake",
]);
const LAUNCHERS = new Set(["npx", "pnpx", "bunx", "uvx", "poetry", "pipenv"]);
const TASK_RISK =
  /\b(curl|wget|nc|ncat|ssh|scp|rsync|rm|sudo|dd|kill|publish|deploy|push|release|upload|bash|sh|zsh|node|python|python3|perl|ruby)\b/;
const SHELL_META = /[;&|<>$`(){}*?~\\\n]/;

const workspaceLocal = (args: readonly string[]) =>
  args.every((a) => !a.startsWith("/") && !a.split("/").includes(".."));

/**
 * How a command reads as a project routine:
 *
 * - `none` — not a routine command.
 * - `routine` — a recognized build/test/lint name. The name alone does not show what runs (a Makefile
 *   target, a `conftest.py`, a plugin, a config file), so it is **not** a bounded proof — the core
 *   still reads it as a run and asks.
 */
type RoutineReading = "none" | "routine";

export function routineReading(
  command: string,
  invs: readonly Invocation[],
  ctx: FactsContext,
): RoutineReading {
  if (invs.length !== 1 || SHELL_META.test(command)) return "none";
  const inv = invs[0];
  if (inv?.name == null || inv.redirects.length > 0 || !inv.args.every((a) => a.literal))
    return "none";
  if (command.trim().split(/\s+/)[0] !== inv.name) return "none";
  const positional = inv.args.map((a) => a.text).filter((a) => !a.startsWith("-"));
  const allArgs = inv.args.map((a) => a.text);
  if (!workspaceLocal(allArgs.filter((a) => !a.startsWith("-")))) return "none";

  const runner = ROUTINE_RUNNERS.find((r) => r.names.includes(inv.name as string));
  if (runner) {
    const task = runner.allowRun && positional[0] === "run" ? positional[1] : positional[0];
    if (task === undefined || !runner.tasks.includes(task)) return "none";
    // A manifest runner counts as routine only when the task is declared there
    // and its body is not obviously risky; a bare-target runner (`make`,
    // `cargo`) counts by name. The declared body still does not prove what
    // runs, so the reading is never more than routine.
    if (!runner.declared) return "routine";
    const body = ctx.declaredTasks?.[task];
    return body !== undefined && !TASK_RISK.test(body) ? "routine" : "none";
  }
  const tool = LAUNCHERS.has(inv.name) ? positional[0] : inv.name;
  return tool !== undefined && ROUTINE_TOOLS.has(tool) ? "routine" : "none";
}

/**
 * Whether a lone removal carries a flag the closed shape cannot spell.
 *
 * @param invs - The invocations the walker collected.
 * @returns True when the only command is a removal with an unmodelled flag.
 */
export function removalFlagsUnknown(invs: readonly Invocation[]): boolean {
  const only = invs.length === 1 ? invs[0] : undefined;
  return (
    (only?.name === "rm" || only?.name === "rmdir") &&
    !only.args.every((a) => allowedRemovalWord(a.text))
  );
}

/** What the free-exit shape needs to know about the text around it. */
export interface FreeExitInput {
  /** The invocations the walker collected. */
  readonly invs: readonly Invocation[];
  /** The words the text reads a path from. */
  readonly reads: readonly Arg[];
  /** The scope resolver, for the build-output test. */
  readonly resolver: PathResolver;
  /** The command text's settled path scope. */
  readonly scope: PathScope;
  /** Whether the text changes directory. */
  readonly cdSeen: boolean;
}

/**
 * Whether the text is exactly the closed build-output delete shape.
 *
 * @param input - The invocations, their reads, and the settled scope.
 * @returns True only for a single unredirected removal of a build output.
 */
export function freeExitReading(input: FreeExitInput): boolean {
  const { invs, reads, resolver, scope, cdSeen } = input;
  const only = invs.length === 1 ? invs[0] : undefined;
  const noRedirect = invs.every((i) => i.redirects.length === 0);
  const deletesNames =
    (only !== undefined &&
      (only.name === "rm" || only.name === "rmdir") &&
      only.args.every((a) => allowedRemovalWord(a.text))) ||
    (only?.name === "find" &&
      (only.args.some((a) => a.text === "-delete") || execDeletesBuildOutput(only.args)));
  const buildPathsOk =
    deletesNames &&
    noRedirect &&
    reads.length > 0 &&
    reads.every((a) => resolver.buildRoot(a)) &&
    !cdSeen;
  const findOk =
    deletesNames &&
    noRedirect &&
    findNamesBuildOutput(invs) &&
    !cdSeen &&
    (scope === "inside" || scope === "none");
  return buildPathsOk || findOk;
}

/**
 * Whether a `find` selects a build output by name or path.
 *
 * @param invs - The invocations the walker collected.
 * @returns True when `-name`/`-path` takes a build-output name.
 */
function findNamesBuildOutput(invs: readonly Invocation[]): boolean {
  for (const inv of invs) {
    if (inv.name !== "find") continue;
    const texts = inv.args.map((a) => a.text);
    const at = texts.findIndex((t) => t === "-name" || t === "-path");
    if (at >= 0 && BUILD_NAMES.has(texts[at + 1] ?? "")) return true;
  }
  return false;
}
