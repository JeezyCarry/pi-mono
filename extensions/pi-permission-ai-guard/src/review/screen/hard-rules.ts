/**
 * The closed v1 hard-deny rules: operations no context makes right. Each rule
 * reads one literal-word simple command (or one pipeline) and fires only when
 * every word it inspects is a plain literal; a variable, substitution or any
 * other shape never matches, so the screen can only deny what the text
 * demonstrably says. The set is closed on purpose: adding a rule is a code
 * change with its own match and never-match tests, not a configuration.
 */
import type { PipelineWords } from "#src/review/request/shell-ast.ts";
import { unwrap } from "#src/review/request/shell-ast.ts";

/** A rule hit: the rule's stable id and the reason shown to the agent. */
export interface HardRuleHit {
  readonly rule: string;
  readonly reason: string;
}

const SYSTEM_ROOTS: ReadonlySet<string> = new Set([
  "/",
  "~",
  "/usr",
  "/etc",
  "/boot",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/var",
  "/root",
  "/home",
  "/dev",
  "/sys",
  "/proc",
]);

const SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const DOWNLOADERS: ReadonlySet<string> = new Set(["curl", "wget"]);
const PROTECTED_BRANCHES: ReadonlySet<string> = new Set(["main", "master"]);

function baseName(word: string): string {
  return word.slice(word.lastIndexOf("/") + 1);
}

function normalizeRoot(target: string): string {
  const stripped = target.replace(/\/\*$/, "/").replace(/(.)\/+$/, "$1");
  return stripped === "" ? "/" : stripped;
}

function isRecursiveFlag(word: string): boolean {
  if (word === "--recursive") return true;
  return /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(word);
}

function recursiveRemoveOfSystemRoot(args: readonly string[]): HardRuleHit | null {
  if (!args.some(isRecursiveFlag)) return null;
  const hit = args
    .filter((word) => !word.startsWith("-"))
    .find((target) => SYSTEM_ROOTS.has(normalizeRoot(target)));
  return hit === undefined
    ? null
    : {
        rule: "rm-system-root",
        reason: "recursively deleting a system root or the home directory is never allowed",
      };
}

function rawDeviceWrite(args: readonly string[]): HardRuleHit | null {
  const target = args.find((word) => word.startsWith("of=/dev/"));
  if (target === undefined || target === "of=/dev/null") return null;
  return {
    rule: "raw-device-write",
    reason: "writing directly to a block device destroys its contents and is never allowed",
  };
}

function setuidChmod(args: readonly string[]): HardRuleHit | null {
  const mode = args.find(
    (word) => /^[ugoa]*\+[rwxXt]*s[rwxXt]*$/.test(word) || /^[2467][0-7]{3}$/.test(word),
  );
  if (mode === undefined) return null;
  return {
    rule: "chmod-setuid",
    reason: "setting the setuid or setgid bit is never allowed",
  };
}

function forcePushToProtectedBranch(args: readonly string[]): HardRuleHit | null {
  if (args[0] !== "push") return null;
  const rest = args.slice(1);
  const forced = rest.some(
    (word) => word === "--force" || word === "-f" || (word.startsWith("+") && word.length > 1),
  );
  if (!forced) return null;
  const toProtected = rest.some((word) => {
    const ref = word.replace(/^\+/, "").split(":").at(-1) ?? "";
    return PROTECTED_BRANCHES.has(ref.replace(/^refs\/heads\//, ""));
  });
  return toProtected
    ? {
        rule: "force-push-protected",
        reason: "force-pushing main or master rewrites shared history and is never allowed",
      }
    : null;
}

function reverseShell(name: string, args: readonly string[]): HardRuleHit | null {
  const netcat =
    ["nc", "ncat", "netcat"].includes(name) && args.some((word) => /^-[a-zA-Z]*[ec]/.test(word));
  const socat = name === "socat" && args.some((word) => /^(EXEC|SYSTEM):/i.test(word));
  return netcat || socat
    ? {
        rule: "reverse-shell",
        reason: "binding a shell to a network connection is never allowed",
      }
    : null;
}

/**
 * Match one simple command against the rules.
 *
 * @param words - The command's literal words.
 * @returns The hit, or null.
 */
export function matchCommandRule(words: readonly string[]): HardRuleHit | null {
  const [head, ...args] = unwrap(words);
  if (head === undefined) return null;
  const name = baseName(head);
  if (name === "rm") return recursiveRemoveOfSystemRoot(args);
  if (name === "dd") return rawDeviceWrite(args);
  if (/^mkfs(\.|$)/.test(name)) {
    return {
      rule: "mkfs",
      reason: "creating a filesystem destroys the device's contents and is never allowed",
    };
  }
  if (name === "chmod") return setuidChmod(args);
  if (name === "git") return forcePushToProtectedBranch(args);
  return reverseShell(name, args);
}

/**
 * Match one pipeline against the rules.
 *
 * @param stages - The literal words of each stage.
 * @returns The hit, or null.
 */
export function matchPipelineRule(stages: PipelineWords): HardRuleHit | null {
  const names = stages.map((words) => (words === null ? null : baseName(unwrap(words)[0] ?? "")));
  const lastShell = names.findLastIndex((name) => name !== null && SHELLS.has(name));
  if (lastShell <= 0) return null;
  const shellWords = stages[lastShell] ?? [];
  if (unwrap(shellWords).includes("-c")) return null;
  const downloads = names
    .slice(0, lastShell)
    .some((name) => name !== null && DOWNLOADERS.has(name));
  return downloads
    ? {
        rule: "pipe-to-shell",
        reason:
          "piping a download into a shell executes unreviewed remote code and is never allowed",
      }
    : null;
}
