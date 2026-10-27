/**
 * Which command names are shells. Two independent readers ask this — the screen
 * (is a download piped into a program?) and the fact walker (does a `-c` string
 * run as shell?) — so the vocabulary lives here rather than in either, and the
 * two cannot drift into disagreeing about what runs.
 *
 * Inclusion test: the name executes its `-c` operand as a shell program and
 * reads a heredoc or piped stdin as a program. Both are what makes the name a
 * place code can hide. Every name here was checked against its own manual; a
 * name is not added on familiarity.
 *
 * Two grammar families sit here on purpose. The deny rules match literal
 * destructive words (`rm -rf /`, `dd of=`, …) that spell the same in each, so
 * a parse that misreads a foreign construct (`$()` in a shell that has no
 * such substitution) lands on the over-block side, never the under-block one.
 * The names left out fail the test outright:
 *
 * - `busybox`: an applet multiplexer. `busybox -c …` is not a shell invocation; `busybox sh -c …` is,
 *   and `sh` is already here.
 * - `pwsh` / `powershell`: `-c` runs PowerShell, where the words do not mean what a shell parse would
 *   say (`rm` is an alias for `Remove-Item`, paths are drive-qualified, its option grammar is its
 *   own). Reading it would not approximate the language, it would invent one.
 * - `oil` / `osh` / `elvish` / `ion` / `nu`: unverified here, so left out. Each is a candidate for
 *   its own match + never-match test pair, not a name to add on familiarity.
 *
 * A false entry is worse than a missing one in the mouth of a deny rule: a name
 * added on a guess would hard-deny benign commands on hosts where that name is
 * something else entirely.
 */

/**
 * Shell names whose `-c` operand is a shell program. Ordering is alphabetical so
 * a reader can confirm a name's presence at a glance.
 */
export const SHELL_INTERPRETERS: ReadonlySet<string> = new Set([
  "ash",
  "bash",
  "csh",
  "dash",
  "fish",
  "ksh",
  "mksh",
  "pdksh",
  "sh",
  "tcsh",
  "yash",
  "zsh",
]);

/**
 * Names whose stdin can be a program rather than data. The shell members are
 * read as programs by the screen's walker, which requires both this set and
 * `SHELL_INTERPRETERS` — so the non-shell tail below is asked by no reader
 * today: it is carried unchanged from before this set was shared, and it
 * documents the interpreter rule's reach rather than a walker behaviour.
 */
export const STDIN_IS_PROGRAM: ReadonlySet<string> = new Set([
  ...SHELL_INTERPRETERS,
  // The non-shell members are carried over unchanged: widening or narrowing
  // this tail is its own decision, not part of adding shell names.
  "python",
  "python3",
  "node",
  "perl",
  "ruby",
  "php",
  "sqlite3",
  "mysql",
]);
