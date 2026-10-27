/**
 * The fact vocabulary: what a command text provably does. The public types are
 * re-exported from `command-facts.ts`; the word-level tokens are shared by the
 * walker that reads text and the reader that classifies invocations.
 */

/** Where the paths a command touches lie, relative to the working directory. */
export type PathScope = "inside" | "outside" | "scratch" | "none" | "unknown";

/**
 * Network reach of a command. `public` and `local` are provable from literal hosts;
 * anything else that touches the network (private or metadata addresses, hosts built
 * from variables, no literal host at all) is `restricted`.
 */
export type NetworkAccess = "none" | "local" | "public" | "restricted";

/** Environment the facts are computed against. */
export interface FactsContext {
  readonly cwd: string;
  readonly home?: string;
  /** Resolves symlinks of an existing path; null when the path does not exist. */
  readonly realpath?: (path: string) => string | null;
  /**
   * Declared project tasks (name to command line), e.g. from a package manifest; absent vouches for
   * nothing.
   */
  readonly declaredTasks?: Readonly<Record<string, string>>;
}

/**
 * What the command's verbs demonstrably do, from a closed verb table. `unknown` means at
 * least one verb is outside the table, so the code cannot vouch for what the command does.
 */
export type CommandEffect = "read" | "modify" | "delete" | "send_out" | "unknown";

/** The facts the classifier decision table reads. */
export interface CommandFacts {
  /** False when the text did not parse; the path and network facts are then conservative. */
  readonly parsed: boolean;
  readonly pathScope: PathScope;
  /** Every path word names a build or cache output directory inside the project. */
  readonly namedBuildOutput: boolean;
  readonly recursive: boolean;
  readonly publishesArtifact: boolean;
  readonly sensitivePathName: boolean;
  /** Reads only paths that publish host facts — a fixed Unix list today. */
  readonly publicSystemPath: boolean;
  readonly rewritesHistory: boolean;
  readonly rawCopy: boolean;
  readonly allInterfaces: boolean;
  readonly network: NetworkAccess;
  readonly dumpsEnvironment: boolean;
  readonly installsPersistence: boolean;
  /**
   * A `chmod` wording that sets any group or other permission bit. It reads the
   * words only and cannot see the prior mode, so it states "this asks for a
   * class wider than the owner", not "this widened the file". The table decides
   * whether the path makes that a protection question.
   */
  readonly grantsBeyondOwner: boolean;
  /** A network command in a sending shape (upload, POST, copy to a host, remote execution). */
  readonly sendsData: boolean;
  readonly commandEffect: CommandEffect;
  /** A variable whose name marks a secret (`$GITHUB_TOKEN`) is expanded. */
  readonly secretVariable: boolean;
  /**
   * A `-H`/`--header` value carrying a literal token (`Authorization:
   * Bearer ghp_...`). Symmetric with `secretVariable`: that one names
   * the secret by variable, this one by value. Joins the same
   * `credential` disjunction — read or send of a header token asks at
   * least as hard as a variable-named one.
   */
  readonly headerToken: boolean;
  /**
   * An auth-carrying header (`Authorization`, `Proxy-Authorization`,
   * `X-Api-Key`) whose value is an unreadable expansion (`$VAL`,
   * `$(...)`). Proven spellings are curl's `-H`/`--header` (separate and
   * attached) and `--header` on wget; wget's `-H` is `--span-hosts`, not
   * a header, and a whole-word expansion or a file reference cannot prove
   * a field name, so neither counts. The fact states "an authentication
   * value leaves in a form the record cannot show", never "this is a
   * credential": a request-id or content-type expansion must not trip
   * it, and a single-quoted (literal) value must not either. The table
   * reads it as an escalator — a named request still asks — rather than
   * as a credential row.
   */
  readonly authHeaderExpansion: boolean;
  /** A single literal project build, test or lint command recognized by name. */
  readonly routineDevCommand: boolean;
  /** A `/dev/tcp` or `/dev/udp` path in an argument or a redirect target (a shell socket). */
  readonly socketRedirection: boolean;
  /** A loop in the text also backgrounds a command: unbounded process spawn. */
  readonly unboundedSpawn: boolean;
}

export interface Arg {
  readonly text: string;
  /** True when the word is made of plain and quoted literals only. */
  readonly literal: boolean;
}

export interface Redirect {
  readonly op: string;
  readonly target: Arg;
  /** True when the heredoc body carries expansion or quoting the reader declines. */
  readonly opaque?: boolean;
}

export interface Invocation {
  /** The effective command after wrappers; null when it is not a literal word. */
  readonly name: string | null;
  readonly args: readonly Arg[];
  readonly redirects: readonly Redirect[];
  readonly dumpsEnv: boolean;
}

export interface Collected {
  invocations: Invocation[];
  opaque: boolean;
  parsed: boolean;
  /** A `/dev/tcp` or `/dev/udp` path in any argument or redirect target. */
  socket: boolean;
  /** Any statement is backgrounded (`&`). */
  background: boolean;
  /** The text contains a loop construct. */
  loop: boolean;
  /** A loop whose termination the text cannot prove (`while`/`until`/C-style, or an expanding list). */
  unboundedLoop: boolean;
}
