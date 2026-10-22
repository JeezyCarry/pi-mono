/**
 * What a command's verbs demonstrably do, and how far its network reach goes:
 * the closed verb tables, the effect ladder, the sending shapes and the
 * literal-host classification.
 */
import { bundledFlagHas } from "#src/utils.ts";

import { IGNORED_REDIRECT_TARGET } from "./scope.ts";
import { headerField } from "./syntax.ts";
import type { Arg, CommandEffect, Invocation, NetworkAccess, Redirect } from "./types.ts";

/** Verbs a URL argument makes a network contact; a URL argument marks any verb. */
const NETWORK_COMMANDS = new Set([
  "curl",
  "wget",
  "nc",
  "ncat",
  "netcat",
  "socat",
  "ssh",
  "scp",
  "sftp",
  "rsync",
  "ftp",
  "telnet",
]);

/** A URL's scheme and authority separator (the host class comes from `classifyHost`). */
const SCHEME_URL = /[a-z][a-z0-9+.-]*:\/\/([^/?#\s]*)/gi;

function classifyHost(authority: string): "local" | "public" | "restricted" {
  const host = authority.slice(authority.lastIndexOf("@") + 1);
  let name: string;
  if (host.startsWith("[")) {
    name = host.slice(1, host.indexOf("]") < 0 ? undefined : host.indexOf("]")).toLowerCase();
    return name === "::1" ? "local" : "restricted";
  }
  name = (host.split(":")[0] ?? "").toLowerCase();
  if (name === "") return "restricted";
  if (name === "localhost" || /^127(\.\d{1,3}){3}$/.test(name)) return "local";
  if (!name.includes(".")) return "restricted";
  if (/^[0-9a-fx.]+$/.test(name)) {
    const quad = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name);
    if (!quad) return "restricted";
    const [a, b] = [Number(quad[1]), Number(quad[2])];
    if (a === 10 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31))
      return "restricted";
    if (a === 169 && b === 254) return "restricted";
    if (a === 100 && b >= 64 && b <= 127) return "restricted";
    return "public";
  }
  if (/\.(internal|local|lan|corp|localdomain|home\.arpa)$/.test(name)) return "restricted";
  return "public";
}

export function networkOf(invs: readonly Invocation[], opaque: boolean): NetworkAccess {
  let uses = false;
  let restricted = opaque;
  const hosts: string[] = [];
  for (const inv of invs) {
    const net = inv.name !== null && NETWORK_COMMANDS.has(inv.name);
    let literalUrl = false;
    for (const target of inv.redirects.map((r) => r.target)) {
      if (/^\/dev\/(tcp|udp)\//.test(target.text)) {
        uses = true;
        restricted = true;
      }
    }
    for (const arg of inv.args) {
      const urls = [...arg.text.matchAll(SCHEME_URL)];
      if (urls.length > 0) {
        uses = true;
        literalUrl = true;
        for (const m of urls) hosts.push(m[1] ?? "");
        if (!arg.literal) restricted = true;
      }
      if (net && !arg.literal) restricted = true;
    }
    if (net) {
      uses = true;
      if (!literalUrl) restricted = true;
    }
  }
  if (!uses) return opaque ? "restricted" : "none";
  const kinds = hosts.map(classifyHost);
  if (restricted || kinds.includes("restricted")) return "restricted";
  return kinds.every((k) => k === "local") ? "local" : "public";
}

/** A `git` subcommand word and the args after it. */
interface GitSubcommand {
  readonly sub: string;
  readonly rest: readonly string[];
}

export function gitSubcommand(args: readonly Arg[]): GitSubcommand | null {
  for (let i = 0; i < args.length; i++) {
    const t = args[i]?.text;
    if (t === undefined) break;
    if (t === "-C" || t === "-c") {
      i++;
      continue;
    }
    if (t.startsWith("-")) continue;
    return { sub: t, rest: args.slice(i + 1).map((a) => a.text) };
  }
  return null;
}

export function bindsLoopbackOnly(args: readonly Arg[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const t = args[i]?.text;
    if (t === undefined) break;
    let value: Arg | undefined;
    if (t === "--bind" || t === "-b") value = args[i + 1];
    else if (t.startsWith("--bind="))
      value = { text: t.slice(7), literal: args[i]?.literal ?? false };
    if (value) return value.literal && classifyHost(value.text) === "local";
  }
  return false;
}

const ALWAYS_SENDING = new Set([
  "scp",
  "rsync",
  "sftp",
  "nc",
  "ncat",
  "netcat",
  "socat",
  "ssh",
  "ftp",
  "telnet",
]);

/**
 * A value shaped like a token: a known secret prefix, or a long mixed
 * string (hex/base64 of 32+ chars). Length floor 20 keeps short words
 * (`status`, `latest`) out; the charset test keeps plain English out.
 */
const TOKEN_PREFIX = /^(sk-|ghp_|AKIA|eyJ)/;
const TOKEN_LONG = /\b(?:[0-9a-fA-F]{32,}|[0-9A-Za-z+/=]{32,})\b/;
export function looksLikeToken(value: string): boolean {
  if (value.length < 20) return false;
  if (TOKEN_PREFIX.test(value)) return true;
  if (!TOKEN_LONG.test(value)) return false;
  // Mixed charset: letters AND digits (or +/=), so `latest/meta-data/iam`
  // style paths and plain words never match.
  return /[A-Za-z]/.test(value) && /[0-9+/=]/.test(value);
}

// A subdomain label that looks encoded: abnormally long (40+) or
// token-shaped. This is the DNS-exfiltration shape (`<data>.x.example`).
function hasEncodedSubdomain(host: string): boolean {
  return host
    .toLowerCase()
    .split(".")
    .some((label) => label.length >= 40 || looksLikeToken(label));
}

// `sendsData` also covers data riding in the URL: an expansion
// (`?k=$(cat .env)` — the arg is non-literal, so local data flows into
// the request), a token-shaped query/path value, or an encoded
// subdomain. Text-only, no file reads, no user message. This only ever
// tightens: the escalator lifts to guard, never releases.
function urlCarriesData(arg: Arg): boolean {
  const urls = [...arg.text.matchAll(SCHEME_URL)];
  if (urls.length === 0) return false;
  // Expansion follows the AST's `literal` flag — NOT a text scan for `$`:
  // single quotes suppress substitution (`'$(...)'` is inert text),
  // double quotes and bare words expand. A `/\$/` text test here
  // misread quoted inert text as data in flight (false positive).
  if (!arg.literal) return true;
  for (const m of urls) {
    const authority = m[1] ?? "";
    const host = authority.slice(authority.lastIndexOf("@") + 1).split(":")[0] ?? "";
    if (hasEncodedSubdomain(host)) return true;
    const afterHost = arg.text.slice((m.index ?? 0) + m[0].length - (m[1] ?? "").length);
    const tail = afterHost.slice(host.length);
    // Split on URL structure only (? & = / #) — token chars (`_`, `-`,
    // `.`, `=`) stay inside the value so prefix-anchored shapes match.
    for (const value of tail.split(/[?&=/#]+/)) {
      if (looksLikeToken(value)) return true;
    }
  }
  return false;
}

export function sendsDataShape(name: string, args: readonly Arg[]): boolean {
  if (ALWAYS_SENDING.has(name)) return true;
  const texts = args.map((a) => a.text);
  if ((name === "docker" || name === "podman" || name === "kubectl") && texts.includes("exec"))
    return true;
  if (name !== "curl" && name !== "wget") return false;
  if (args.some(urlCarriesData)) return true;
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i];
    if (t === undefined) break;
    if (/^--(data|data-\w+|form|form-string|upload-file|post-data|post-file|json)(=|$)/.test(t))
      return true;
    if (/^-[a-zA-Z]*[dFT]$/.test(t) && !t.startsWith("--")) return true;
    if (t === "-X" || t === "--request") {
      if (/^(POST|PUT|PATCH|DELETE)$/i.test(texts[i + 1] ?? "")) return true;
    }
    if (/^(-X|--request=)(POST|PUT|PATCH|DELETE)$/i.test(t)) return true;
  }
  return false;
}

const EFFECT_RANK: Record<CommandEffect, number> = {
  read: 0,
  modify: 1,
  delete: 2,
  send_out: 3,
  unknown: 4,
};

const READ_VERBS = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "wc",
  "diff",
  "cmp",
  "file",
  "du",
  "df",
  "stat",
  "pwd",
  "echo",
  "printf",
  "cd",
  "pushd",
  "popd",
  "date",
  "uname",
  "whoami",
  "id",
  "hostname",
  "uptime",
  "free",
  "nproc",
  "ps",
  "pgrep",
  "which",
  "type",
  "true",
  "false",
  "sleep",
  "test",
  "[",
  "sort",
  "uniq",
  "cut",
  "tr",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "lsblk",
  "lscpu",
  "tree",
  "jq",
  "export",
  "printenv",
  "set",
  "env",
  "wait",
  "export",
  "declare",
  "typeset",
  "local",
  "readonly",
  "history",
  "sha256sum",
  "md5sum",
  "sha1sum",
  "column",
  "paste",
  "nl",
  "seq",
]);
const WRITE_VERBS = new Set([
  "touch",
  "mkdir",
  "cp",
  "mv",
  "ln",
  "chmod",
  "chown",
  "chgrp",
  "tee",
  "install",
  "mktemp",
]);
const DELETE_VERBS = new Set([
  "rm",
  "rmdir",
  "unlink",
  "shred",
  "truncate",
  "kill",
  "pkill",
  "killall",
  "mkfs",
  "wipefs",
]);

const GIT_READ = new Set([
  "status",
  "log",
  "diff",
  "show",
  "rev-parse",
  "ls-files",
  "blame",
  "describe",
  "shortlog",
  "grep",
  "ls-remote",
  "rev-list",
  "reflog",
]);
const GIT_WRITE = new Set([
  "add",
  "commit",
  "switch",
  "fetch",
  "merge",
  "cherry-pick",
  "revert",
  "mv",
  "init",
  "clone",
  "worktree",
]);
const GIT_DELETE = new Set(["clean", "reset", "restore", "rebase", "filter-branch", "gc", "prune"]);

export function maxEffect(a: CommandEffect, b: CommandEffect): CommandEffect {
  return EFFECT_RANK[a] >= EFFECT_RANK[b] ? a : b;
}

function gitEffect(args: readonly Arg[]): CommandEffect {
  const g = gitSubcommand(args);
  if (!g) return "unknown";
  const { sub, rest } = g;
  if (GIT_READ.has(sub)) return "read";
  if (sub === "push") return "send_out";
  if (GIT_DELETE.has(sub)) return "delete";
  if (sub === "checkout") return rest.includes("--") || rest.includes(".") ? "delete" : "modify";
  if (sub === "branch") {
    if (rest.some((t) => /^(-d|-D|--delete|-m|-M)$/.test(t))) return "delete";
    return rest.some((t) => !t.startsWith("-")) ? "modify" : "read";
  }
  if (sub === "stash")
    return rest[0] === "list" || rest[0] === "show"
      ? "read"
      : rest[0] === "drop" || rest[0] === "clear"
        ? "delete"
        : "modify";
  if (sub === "tag")
    return rest.length === 0 || rest.includes("-l")
      ? "read"
      : rest.includes("-d")
        ? "delete"
        : "modify";
  if (sub === "remote")
    return rest.length === 0 || rest[0] === "-v" || rest[0] === "show" || rest[0] === "get-url"
      ? "read"
      : "modify";
  if (sub === "config")
    return rest.includes("--get") || rest.includes("--list") || rest.includes("-l")
      ? "read"
      : "modify";
  if (GIT_WRITE.has(sub)) return "modify";
  return "unknown";
}

function subcommandEffect(name: string, args: readonly Arg[]): CommandEffect {
  const t = args.filter((a) => !a.text.startsWith("-")).map((a) => a.text);
  const sub = t[0] ?? "";
  if (name === "docker" || name === "podman") {
    if (
      [
        "ps",
        "images",
        "logs",
        "inspect",
        "version",
        "info",
        "stats",
        "top",
        "port",
        "history",
      ].includes(sub)
    )
      return "read";
    if (["rm", "rmi", "prune", "kill", "stop", "system"].includes(sub)) return "delete";
    if (sub === "container" || sub === "image" || sub === "volume" || sub === "network") {
      return ["ls", "inspect", "list"].includes(t[1] ?? "")
        ? "read"
        : ["rm", "prune"].includes(t[1] ?? "")
          ? "delete"
          : "unknown";
    }
    return "unknown";
  }
  if (name === "kubectl") {
    if (["get", "describe", "logs", "top", "version", "explain"].includes(sub)) return "read";
    return sub === "delete" ? "delete" : "unknown";
  }
  if (name === "systemctl")
    return ["status", "is-active", "is-enabled", "list-units", "show"].includes(sub)
      ? "read"
      : "unknown";
  if (name === "crontab")
    return args.some((a) => a.text === "-l")
      ? "read"
      : args.some((a) => a.text === "-r")
        ? "delete"
        : "unknown";
  if (name === "npm" || name === "pnpm" || name === "yarn")
    return ["ls", "list", "view", "info", "outdated", "why"].includes(sub) ? "read" : "unknown";
  if (name === "pip" || name === "pip3")
    return ["list", "show", "freeze"].includes(sub) ? "read" : "unknown";
  if (name === "apt" || name === "apt-get" || name === "dnf" || name === "yum" || name === "brew") {
    return ["remove", "purge", "autoremove", "uninstall"].includes(sub)
      ? "delete"
      : ["list", "show", "search", "info"].includes(sub)
        ? "read"
        : "unknown";
  }
  return "unknown";
}

export function verbEffect(
  name: string | null,
  args: readonly Arg[],
  redirects: readonly Redirect[],
): CommandEffect {
  if (name === null) return "unknown";
  const texts = args.map((a) => a.text);
  let effect: CommandEffect;
  if (name === "git") effect = gitEffect(args);
  else if (name === "find") {
    const exec = texts.findIndex((t) => /^-(exec|execdir|ok|okdir)$/.test(t));
    if (texts.includes("-delete") || (exec >= 0 && texts[exec + 1] === "rm")) effect = "delete";
    else if (exec >= 0 || texts.some((t) => /^-(fprint|fprintf|fls)$/.test(t))) effect = "unknown";
    else effect = "read";
  } else if (name === "sed")
    effect = texts.some((t) => bundledFlagHas(t, "i") || t === "--in-place") ? "modify" : "read";
  else if (name === "curl" || name === "wget") {
    effect = sendsDataShape(name, args)
      ? "send_out"
      : texts.some(
            (t) =>
              /^(-o|-O|--output|--remote-name|-[a-zA-Z]*[oO])$/.test(t) ||
              t.startsWith("--output="),
          ) || name === "wget"
        ? "modify"
        : "read";
  } else if (ALWAYS_SENDING.has(name)) effect = "send_out";
  else if (DELETE_VERBS.has(name)) effect = "delete";
  else if (WRITE_VERBS.has(name)) effect = "modify";
  else if (READ_VERBS.has(name)) effect = "read";
  else effect = subcommandEffect(name, args);
  if (
    effect !== "unknown" &&
    redirects.some(
      (r) => /^(>|>>|>\||&>|&>>|<>)$/.test(r.op) && !IGNORED_REDIRECT_TARGET.test(r.target.text),
    )
  ) {
    effect = maxEffect(effect, "modify");
  }
  return effect;
}

/** What one command text does, as far as the closed verb tables reach. */
export interface EffectScan {
  /** The strongest effect any invocation reaches. */
  readonly commandEffect: CommandEffect;
  /** A `dd` copy, which can move bytes in either direction. */
  readonly rawCopy: boolean;
  /** A word that hands credential-shaped data to a sending command. */
  readonly sendsData: boolean;
  /** The text reads an environment dump (`env`, `printenv`, `set` with no words). */
  readonly dumpsEnvironment: boolean;
  /** A recursive removal or `find -delete`. */
  readonly recursive: boolean;
}

/**
 * Fold the invocations into one effect reading.
 *
 * @param invs - The invocations the walker collected.
 * @param opaque - Whether anything in the text is unreadable, which hides its effect.
 * @returns The effect ladder's maximum plus the flags read in the same pass.
 */
export function scanEffects(invs: readonly Invocation[], opaque: boolean): EffectScan {
  let commandEffect: CommandEffect = opaque ? "unknown" : "read";
  let rawCopy = false;
  let sendsData = false;
  let dumpsEnvironment = false;
  let recursive = false;

  for (const inv of invs) {
    const name = inv.name;
    const texts = inv.args.map((a) => a.text);
    if (inv.dumpsEnv) dumpsEnvironment = true;
    if (
      name === "rm" &&
      inv.args.some((a) => bundledFlagHas(a.text, "rR") || a.text === "--recursive")
    ) {
      recursive = true;
    }
    if (name === "find" && texts.includes("-delete")) recursive = true;
    // `dd` reaches whatever its operands are; its own verb cannot say.
    commandEffect = maxEffect(
      commandEffect,
      name === "dd" ? "unknown" : verbEffect(name, inv.args, inv.redirects),
    );
    if (name === "dd") rawCopy = true;
    if (name !== null && sendsDataShape(name, inv.args)) sendsData = true;
  }

  return { commandEffect, rawCopy, sendsData, dumpsEnvironment, recursive };
}

/**
 * Whether the text publishes an artifact somewhere others consume it.
 *
 * @param invs - The invocations the walker collected.
 * @returns True when a publish verb targets a registry or release.
 */
export function publishingCommands(invs: readonly Invocation[]): boolean {
  return invs.some((inv) => {
    const name = inv.name;
    const texts = inv.args.map((a) => a.text);
    if (
      (name === "npm" || name === "pnpm" || name === "yarn" || name === "cargo") &&
      texts.includes("publish")
    ) {
      return true;
    }
    if (name === "twine" && texts.includes("upload")) return true;
    if ((name === "docker" || name === "podman") && texts.includes("push")) return true;
    return name === "gh" && texts.includes("release") && texts.includes("create");
  });
}

/**
 * Whether the text discards work no stored revision holds.
 *
 * @param invs - The invocations the walker collected.
 * @returns True when a git subcommand rewrites or discards history/worktree content.
 */
export function historyRewrites(invs: readonly Invocation[]): boolean {
  for (const inv of invs) {
    if (inv.name !== "git") continue;
    const g = gitSubcommand(inv.args);
    if (!g) continue;
    if (g.sub === "commit" && g.rest.includes("--amend")) return true;
    if (["rebase", "reset", "filter-branch"].includes(g.sub)) return true;
    // Discarding worktree content destroys uncommitted work, which no stored
    // revision holds. `git checkout <tree-ish> -- <path>` is the discard form;
    // a bare checkout only moves HEAD.
    if (g.sub === "restore") return true;
    if (g.sub === "checkout" && g.rest.includes("--")) return true;
    if (g.sub === "clean" && g.rest.some((t) => bundledFlagHas(t, "fdx"))) return true;
    if (g.sub === "branch" && g.rest.some((t) => t === "-D" || t === "-d" || t === "--delete")) {
      return true;
    }
  }
  return false;
}

/**
 * Whether the text binds a server to every interface rather than loopback.
 *
 * @param invs - The invocations the walker collected.
 * @returns True for a wildcard address or a module server without a loopback bind.
 */
export function listensOnAllInterfaces(invs: readonly Invocation[]): boolean {
  return invs.some((inv) => {
    const texts = inv.args.map((a) => a.text);
    if (inv.args.some((a) => a.text.includes("0.0.0.0") || a.text === "::" || a.text === "[::]")) {
      return true;
    }
    return texts.includes("http.server") && !bindsLoopbackOnly(inv.args);
  });
}

/** The credential readings one command text supports. */
export interface CredentialReadings {
  /** A credential-shaped variable is named anywhere the text reaches. */
  readonly secretVariable: boolean;
  /** A literal token sits in a header value. */
  readonly headerToken: boolean;
  /** An auth-carrying header value is an expansion, so the record cannot show it. */
  readonly authHeaderExpansion: boolean;
}

/**
 * Read the credential evidence from the text and its headers.
 *
 * @param command - The full command text.
 * @param invs - The invocations the walker collected.
 * @param opaque - Whether anything in the text is unreadable.
 * @returns The credential readings; each is positive evidence only.
 */
export function credentialReadings(
  command: string,
  invs: readonly Invocation[],
  opaque: boolean,
): CredentialReadings {
  // Variables inside a bare test (`[ -n "$API_KEY" ]`) never leave the process.
  const testOnly = invs.length > 0 && invs.every((i) => i.name === "[" || i.name === "test");
  const secretVariable =
    !testOnly &&
    /\$\{?[A-Za-z0-9_]*(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|CREDENTIAL|ACCESS_KEY)/i.test(
      command,
    );
  // A `-H`/`--header` value carrying a literal token. The value must be
  // literal text (`-H "Authorization: Bearer $TOKEN"` is an expansion — the
  // value is unreadable). Only the token-shaped literal counts; an expansion
  // in an auth-carrying header is the separate `authHeaderExpansion`
  // escalator instead.
  const headerToken =
    !opaque &&
    invs.some(
      (inv) =>
        (inv.name === "curl" || inv.name === "wget") &&
        inv.args.some((a, i) => {
          // One header reader for both readings: `headerField` proves the field
          // name, so the attached `-H<value>` spelling and the curl-only short
          // form come along, while `wget -H` (`--span-hosts`, not a header)
          // stays out.
          const header = headerField(inv, a, i);
          if (!header || !header.word.literal) return false;
          // Split on header structure too (`:` after the field name, `=` in
          // `Token=...`), so `X-Token:AKIA...` yields the bare token — the
          // field name is never token-shaped itself.
          return header.field.split(/[;:,\s=]+/).some((v) => looksLikeToken(v.trim()));
        }),
    );
  // An auth-carrying header whose value the record cannot show. Header name
  // matches the field name only (`Authorization`, `Proxy-Authorization`,
  // `X-Api-Key`, case-insensitive); the value must be an unreadable expansion —
  // a non-literal argument or a `--header=` word carrying an expansion — so a
  // literal token (already `headerToken`) and a single-quoted inert value stay
  // out. `Cookie` is deliberately excluded: it needs per-key evidence.
  const authHeaderExpansion =
    !opaque &&
    invs.some(
      (inv) =>
        (inv.name === "curl" || inv.name === "wget") &&
        inv.args.some((a, i) => {
          const header = headerField(inv, a, i);
          if (!header) return false;
          const colon = header.field.indexOf(":");
          if (colon <= 0) return false;
          const name = header.field.slice(0, colon).trim().toLowerCase();
          if (name !== "authorization" && name !== "proxy-authorization" && name !== "x-api-key") {
            return false;
          }
          // Unreadable value: the AST flags the word non-literal, and a
          // single-quoted `$VAL` stays literal (inert text).
          return !header.word.literal;
        }),
    );

  return { secretVariable, headerToken, authHeaderExpansion };
}
