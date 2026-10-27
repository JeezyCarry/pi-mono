/**
 * The closed hard-deny rules: operations no context makes right. A rule reads
 * one literal-word simple command, pipeline, or redirect write, and fires only
 * when every word it inspects is a plain literal; a variable, substitution or
 * any other shape never matches, so the screen can only deny what the text
 * demonstrably says. The set is closed on purpose: adding a rule is a code
 * change with its own match and never-match tests, not a configuration.
 */
import {
  DOWNLOADERS,
  unwrap,
  type PipelineWords,
  type RedirectWrite,
} from "#src/review/request/shell-ast.ts";
import { SHELL_INTERPRETERS } from "#src/review/request/shell-names.ts";
import { baseName, bundledFlagHas } from "#src/utils.ts";

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

// Recursive-delete CLIs that read like `rm -rf`: the same shape, the same
// protected roots. A closed set — a new deleter is a code change with its own
// match and never-match tests.
const RECURSIVE_DELETERS: ReadonlySet<string> = new Set([
  "rimraf",
  "del-cli",
  "del",
  "trash",
  "trash-cli",
  "trash-put",
]);

const PROTECTED_BRANCHES: ReadonlySet<string> = new Set(["main", "master"]);

function normalizeRoot(target: string): string {
  const stripped = target.replace(/\/\*$/, "/").replace(/(.)\/+$/, "$1");
  return stripped === "" ? "/" : stripped;
}

// Whether the target is a protected root: a POSIX root from the closed set,
// or a Windows drive ROOT — Git Bash runs the same bash syntax on Windows,
// and `rm -rf C:/` wipes the drive while `rm -rf C:/data` removes one
// directory. A bare `C:` names no root (in shell text it is a relative
// word), and a deeper path is only as bad as any other directory.
function isProtectedRoot(target: string): boolean {
  if (SYSTEM_ROOTS.has(normalizeRoot(target))) return true;
  return /^[a-zA-Z]:\/+$/.test(target.replace(/\/\*$/, "/"));
}

function isRecursiveFlag(word: string): boolean {
  if (word === "--recursive") return true;
  return /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(word);
}

function recursiveTargetOfSystemRoot(args: readonly string[]): string | null {
  if (!args.some(isRecursiveFlag)) return null;
  const hit = args
    .filter((word) => !word.startsWith("-"))
    .find((target) => isProtectedRoot(target));
  return hit ?? null;
}

/**
 * The one recursive-root rule: `rm` and the deleter family share the protected
 * roots and the rule id. `rm` needs an explicit recursive flag, while a deleter
 * is recursive by definition.
 *
 * @param name - The command's basename.
 * @param args - Its literal words after the name.
 * @returns The hit, or null.
 */
function recursiveRootDelete(name: string, args: readonly string[]): HardRuleHit | null {
  const needsFlag = name === "rm";
  if (!needsFlag && !RECURSIVE_DELETERS.has(name)) return null;
  const hit = needsFlag
    ? recursiveTargetOfSystemRoot(args)
    : (args.find((word) => !word.startsWith("-") && isProtectedRoot(word)) ?? null);
  return hit === null
    ? null
    : {
        rule: "rm-system-root",
        reason: `recursively deleting ${hit} with ${name} is never allowed`,
      };
}

function rawDeviceWrite(args: readonly string[]): HardRuleHit | null {
  const target = args.find((word) => word.startsWith("of="));
  if (target === undefined) return null;
  // A block device only: `of=/dev/null`, `of=/dev/stdout` and the other
  // pseudo-devices are ordinary plumbing, and `of=` on a regular file is a
  // file write the model lane judges.
  if (!isBlockDevicePath(target.slice("of=".length))) return null;
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

/**
 * Real block devices. `/dev/tcp/<host>/<port>` is a socket, `/dev/fd/N` a
 * descriptor, `/dev/stdout` a stream and `/dev/shm/…` an ordinary file:
 * writing those destroys no disk, so they never match a device rule.
 */
const BLOCK_DEVICE =
  /^\/dev\/(?:(?:sd|hd|vd|xvd|dasd)[a-z]|nvme\d+n\d+|mmcblk\d+|(?:dm-|md|loop|sr|nbd|zd)\d+|disk\/|mapper\/)/;

function isBlockDevicePath(word: string): boolean {
  return BLOCK_DEVICE.test(word);
}

function diskWipeTool(name: string, args: readonly string[]): HardRuleHit | null {
  const wipes =
    name === "shred" ||
    name === "truncate" ||
    name === "blkdiscard" ||
    name === "hdparm" ||
    name === "nvme";
  if (!wipes) return null;
  // `hdparm --security-erase` and `nvme format` destroy the device's data, but
  // `hdparm -I` and `nvme list` only report it.
  if (name === "hdparm" && !args.some((word) => word.startsWith("--security-erase"))) return null;
  if (
    name === "nvme" &&
    !args.some((word) => word === "format" || word === "sanitize" || word === "delete-ns")
  )
    return null;
  // Only block-device targets: shredding a regular file is a legitimate
  // secure delete, and zeroing a file is a file operation, not a disk wipe.
  const device = args.some((word) => !word.startsWith("-") && isBlockDevicePath(word));
  return device
    ? {
        rule: "disk-wipe-tool",
        reason: `running ${name} on a block device destroys its contents beyond recovery and is never allowed`,
      }
    : null;
}

/** Tools whose final path operand is a destination they write. */
const DEVICE_WRITERS: ReadonlySet<string> = new Set(["tee", "cp", "mv", "install", "rsync"]);

/**
 * A write command aimed at a block device. The *destination* is the operand
 * that destroys: `cp /dev/sda backup.img` reads the device and is allowed.
 *
 * @param name - The command's basename.
 * @param args - Its literal words after the name.
 * @returns The hit, or null.
 */
function writeOntoDevice(name: string, args: readonly string[]): HardRuleHit | null {
  if (!DEVICE_WRITERS.has(name)) return null;
  const operands = args.filter((word) => !word.startsWith("-"));
  if (operands.length === 0) return null;
  // `tee` writes to every operand; the copiers write to the last one only. A
  // target named through `-t`/`--target-directory=` reads as a flag value the
  // last-operand rule misses — model lane, like any option-shaped target.
  const targets = name === "tee" ? operands : operands.slice(-1);
  if (!targets.some((word) => isBlockDevicePath(word))) return null;
  return {
    rule: "device-write",
    reason: `writing onto a block device with ${name} destroys its contents and is never allowed`,
  };
}

/** Tools whose whole purpose is to destroy a partition table or a volume. */
const PARTITION_EDITORS: ReadonlySet<string> = new Set([
  "fdisk",
  "sfdisk",
  "gdisk",
  "sgdisk",
  "cfdisk",
  "parted",
  "wipefs",
]);
const VOLUME_REMOVERS: ReadonlySet<string> = new Set(["lvremove", "pvremove", "vgremove"]);
/**
 * Flags that only report: they make the tool print instead of write. The
 * exemption below applies only when nothing else runs beside the report —
 * `parted /dev/sda print mklabel` still denies.
 */
const REPORTING_FLAGS: ReadonlySet<string> = new Set([
  "-l",
  "--list",
  "-n",
  "--no-act",
  "-V",
  "--version",
  "--help",
  "-h",
  "-d",
  "--dump",
  "print",
]);

/**
 * Partition-table and volume destruction.
 *
 * @param name - The command's basename.
 * @param args - Its literal words after the name.
 * @returns The hit, or null.
 */
function partitionTool(name: string, args: readonly string[]): HardRuleHit | null {
  if (VOLUME_REMOVERS.has(name)) {
    // Removing a logical volume, physical volume or volume group takes its
    // data with it. `-t`/`--test` is a dry run that writes nothing.
    if (args.some((word) => word === "-t" || word === "--test")) return null;
    if (!args.some((word) => !word.startsWith("-"))) return null;
    return {
      rule: "volume-remove",
      reason: `removing a volume with ${name} destroys its contents and is never allowed`,
    };
  }
  if (name === "mdadm") {
    const destructive = ["--zero-superblock", "--create", "--stop", "--remove"];
    return args.some((word) => destructive.includes(word))
      ? {
          rule: "raid-destroy",
          reason: "zeroing or tearing down a RAID array destroys its contents and is never allowed",
        }
      : null;
  }
  if (!PARTITION_EDITORS.has(name)) return null;
  if (
    args.some((word) => REPORTING_FLAGS.has(word)) &&
    args.filter((word) => !word.startsWith("-")).length <= 2
  )
    return null;
  if (!args.some((word) => !word.startsWith("-") && isBlockDevicePath(word))) return null;
  return {
    rule: "partition-destroy",
    reason: `rewriting the partition table with ${name} destroys the disk's contents and is never allowed`,
  };
}

function findDeleteOfSystemRoot(args: readonly string[]): HardRuleHit | null {
  if (!args.includes("-delete")) return null;
  // Only the LEADING non-flag words are start paths; everything from the
  // first `-predicate` on is the expression, and its arguments are values
  // (`-name /` names a pattern, not a root).
  const starts: string[] = [];
  for (const word of args) {
    if (word.startsWith("-")) break;
    starts.push(word);
  }
  const hit = starts.find((target) => isProtectedRoot(target));
  return hit === undefined
    ? null
    : {
        rule: "find-delete-root",
        reason: `deleting everything under ${hit} destroys the system and is never allowed`,
      };
}

function killAllProcesses(args: readonly string[]): HardRuleHit | null {
  // PID -1 is every process the user owns, including the session itself.
  // A listing request (`-l`) only prints a signal name.
  if (!args.includes("-1")) return null;
  if (args.some((word) => word === "-l" || word === "-L" || word === "--list")) return null;
  return {
    rule: "kill-all",
    reason: "killing PID -1 force-kills every process owned by the user and is never allowed",
  };
}

/**
 * Match one redirect write against the rules.
 *
 * @param write - The redirect's operator, literal target, and owning words.
 * @returns The hit, or null.
 */
export function matchRedirectRule(write: RedirectWrite): HardRuleHit | null {
  // A block device only: `/dev/null`, `/dev/stdout`, `/dev/tcp/…` and the
  // other pseudo-devices are ordinary targets, and a socket write is an
  // egress shape the model lane judges, not a disk wipe.
  if (isBlockDevicePath(write.target))
    return {
      rule: "redirect-device-write",
      reason: "redirecting output onto a block device destroys its contents and is never allowed",
    };
  return null;
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
    ["nc", "ncat", "netcat"].includes(name) && args.some((word) => bundledFlagHas(word, "ec"));
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
  if (name === "rm") return recursiveRootDelete(name, args);
  if (name === "dd") return rawDeviceWrite(args);
  if (/^mkfs(\.|$)/.test(name)) {
    // A help or version request runs nothing.
    if (args.some((word) => word === "--help" || word === "--version")) return null;
    return {
      rule: "mkfs",
      reason: "formatting a device destroys its contents and is never allowed",
    };
  }
  if (name === "chmod") return setuidChmod(args);
  if (name === "find") return findDeleteOfSystemRoot(args);
  if (name === "kill") return killAllProcesses(args);
  if (name === "git") return forcePushToProtectedBranch(args);
  return (
    recursiveRootDelete(name, args) ??
    diskWipeTool(name, args) ??
    writeOntoDevice(name, args) ??
    partitionTool(name, args) ??
    reverseShell(name, args)
  );
}

/**
 * Interpreters that execute their stdin as a program when given no script
 * file — the download piped into them runs, exactly like `curl … | sh`.
 * `jq` and friends are filters, not programs, and stay out.
 */
const STDIN_INTERPRETERS: ReadonlySet<string> = new Set([
  "python",
  "python3",
  "node",
  "nodejs",
  "perl",
  "ruby",
]);

/**
 * Match one pipeline against the rules.
 *
 * @param stages - The literal words of each stage.
 * @returns The hit, or null.
 */
export function matchPipelineRule(stages: PipelineWords): HardRuleHit | null {
  const names = stages.map((words) => (words === null ? null : baseName(unwrap(words)[0] ?? "")));
  const lastShell = names.findLastIndex((name) => name !== null && SHELL_INTERPRETERS.has(name));
  if (lastShell > 0) {
    const shellBare = unwrap(stages[lastShell] ?? []);
    // `-c` runs its own string with the download as input data, and a script
    // file operand runs that file: in both cases the download is data, not
    // the program, so neither is a pipe-to-shell.
    if (!shellBare.includes("-c") && !shellBare.slice(1).some((word) => !word.startsWith("-"))) {
      const before = names.slice(0, lastShell);
      // A download only. `history | sh` replays the operator's own words, and
      // a human can ask for that on purpose, so it asks through the model.
      if (before.some((name) => name !== null && DOWNLOADERS.has(name))) {
        return {
          rule: "pipe-to-shell",
          reason:
            "piping a download into a shell executes unreviewed remote code and is never allowed",
        };
      }
    }
  }
  for (let i = 1; i < stages.length; i += 1) {
    const name = names[i];
    if (name === null || !STDIN_INTERPRETERS.has(name)) continue;
    const bare = unwrap(stages[i] ?? []);
    // `-c`/`-e` runs its own string with the download as input data, and a
    // script file operand runs that file: same data-not-program guard.
    if (bare.includes("-c") || bare.includes("-e") || bare.includes("--eval")) continue;
    if (bare.slice(1).some((word) => !word.startsWith("-"))) continue;
    if (names.slice(0, i).some((n) => n !== null && DOWNLOADERS.has(n))) {
      return {
        rule: "pipe-to-interpreter",
        reason:
          "piping a download into an interpreter executes unreviewed remote code and is never allowed",
      };
    }
  }
  return null;
}

/**
 * A called function that backgrounds a pipeline of itself. The walker only
 * records this at a call site inside the same text, so the replication is
 * proven rather than defined.
 *
 * @returns The deny hit for the shape.
 */
export function forkBombHit(): HardRuleHit {
  return {
    rule: "fork-bomb",
    reason:
      "calling a function that backgrounds a pipeline of itself replicates without bound and is never allowed",
  };
}

/**
 * An `eval`/`source` that assembles its program out of a download. The
 * walker proves the substitution runs while the builtin consumes it, so the
 * fetched code provably executes — the same class as a pipe into a shell.
 *
 * @returns The deny hit for the shape.
 */
export function executesFetchHit(): HardRuleHit {
  return {
    rule: "eval-fetch",
    reason:
      "evaluating or sourcing fetched code executes unreviewed remote code and is never allowed",
  };
}
