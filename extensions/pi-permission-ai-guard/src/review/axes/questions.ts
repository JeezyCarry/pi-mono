import type { ClassifierQuestionId } from "#src/config/config-schema.ts";

// ── The action set (request-side vocabulary) ───────────────────────────

/**
 * One action of the classifier request. The four actions split the model's
 * residual judgment — the residue the deterministic fact layer cannot answer —
 * across four axes: whether an in-force prohibition appears in the trusted
 * record, the heaviest action the command's text describes, the kind of thing
 * the action touches, and whether the trusted request named this action.
 * The verdict layer composes the axes, so a predicate about a sister action
 * is a defect here even when it wins a case.
 *
 * Each action answers as a `choice`: pi-ai's bool carries a probability with
 * no confidence field, and its score rungs would collapse a labeled axis into
 * a scale — while the ban and intent axes need the per-label confidence
 * channel the verdict layer gates on. Confidence gates POSITIVE readings
 * only: the negative readings (`none`, `ordinary work declared`, and the
 * request's own word) are adopted whenever a confidence was reported at all,
 * because gating them would let confidence manufacture a missing-evidence
 * wall.
 *
 * Unresolved readings differ by whose record is unclear. `ban=unestablished`
 * means the trusted record leaves a possible prohibition undetermined — it
 * routes to a lean-deny defer, because a prohibition may exist. `effect`,
 * `target` and `intent` read `cannot_determine` when the COMMAND cannot be
 * read (obfuscation, dynamic assembly, an unclear request) — it routes to a
 * neutral defer. The names differ on purpose, and the verdict layer treats
 * them differently.
 */
export interface ClassifierAxisDefinition {
  /** The wire id — one member of {@link CLASSIFIER_QUESTION_IDS}. */
  id: ClassifierQuestionId;
  /** The answer primitive. Every action answers as a `choice`. */
  type: "choice";
  /** The action's own instructions, positive inclusion throughout. */
  instructions: string;
  /** The declared legal labels of the answer space. */
  labels: readonly string[];
  /** The positive definition pi-ai carries per label (the choice menu). */
  criteria: Readonly<Record<string, string>>;
}

/** The `ban` action's legal labels. */
export const BAN_LABELS = ["forbids", "none", "unestablished"] as const;

/**
 * The `effect` action's legal labels: the heaviest action the command's text
 * describes. `read` covers reading, listing, and testing existence alone;
 * `modify` covers creating, overwriting, and changing; `run_program` covers
 * executing code the record does not show. Where the action happens and what
 * it touches are separate questions, answered by the fact layer and the
 * `target` action — never inferred from the label here.
 */
export const EFFECT_LABELS = [
  "read",
  "modify",
  "delete",
  "send_out",
  "run_program",
  "cannot_determine",
] as const;

/**
 * The `target` action's legal labels: the kind of thing the action touches,
 * and nothing else. `ordinary_files` names files with no special standing —
 * a scratch note and a source file share the kind, and the fact layer's path
 * scope carries where each sits. `none` covers commands that operate on no
 * file, repository, or service, so status and listing commands have a
 * definite reading instead of falling into `cannot_determine`.
 */
export const TARGET_LABELS = [
  "ordinary_files",
  "credential_material",
  "vcs_history",
  "system_or_service",
  "none",
  "cannot_determine",
] as const;

/**
 * The `intent` action's legal labels. `requested` requires the request to
 * name this action AND the command to stay inside what the request named:
 * extra files, stronger flags, and chained extra commands all exceed the
 * named scope and read `not_requested`. The action is only asked when the
 * record carries a trusted anchor; without one the verdict layer takes the
 * no-anchor column directly and no model call is spent.
 */
export const INTENT_LABELS = ["requested", "not_requested", "cannot_determine"] as const;

/**
 * The axis questions the classifier request emits — the residue the
 * deterministic fact layer cannot answer, one axis per question: the
 * prohibition, the heaviest action, the kind of thing touched, and the
 * request's word (only when a trusted anchor exists). The verdict layer
 * composes the axes, so a predicate about a sister axis is a defect here even
 * when it wins a case.
 *
 * Positive inclusion (the convention the lanes test): a question and each
 * label definition say what the reading IS — exemptions belong inside positive
 * qualifiers ("a later instruction that explicitly lifts a ban ends its
 * effect"), and the wording carries no exclusion clause, no "as opposed to"
 * contrast, no "excluding"/"rather than" carve-out.
 */
export const CLASSIFIER_QUESTION_SET: readonly ClassifierAxisDefinition[] = [
  {
    id: "ban",
    type: "choice",
    instructions:
      "Does a still-effective instruction in `authorization_anchor` or " +
      "`earlier_context` forbid this action? A later instruction that " +
      "explicitly lifts a ban ends its effect.",
    labels: BAN_LABELS,
    criteria: {
      forbids:
        "A still-effective instruction in `authorization_anchor` or " +
        "`earlier_context` forbids this action.",
      none: "No still-effective instruction forbids this action; a lifted ban leaves it open.",
      unestablished:
        "The record leaves whether a still-effective instruction forbids " +
        "this action undetermined.",
    },
  },
  {
    id: "effect",
    type: "choice",
    instructions:
      "What is the heaviest action this command's own words describe — " +
      "reading, creating or changing, destroying, sending, or running a " +
      "program? Reading, listing, or testing existence alone reads `read`. " +
      "Answer what the words state, and answer `cannot_determine` when the " +
      "words leave the action unreadable.",
    labels: EFFECT_LABELS,
    criteria: {
      read: "The command reads, lists, or tests existence, and does nothing else.",
      modify:
        "The command creates, overwrites, or changes something — including " +
        "registering, installing, or configuring.",
      delete: "The command destroys data, files, history, or state.",
      send_out: "The command sends data or content outward from this machine or workspace.",
      run_program:
        "The command executes code — a script, a test suite, a build, or a " +
        "downloaded program — whose detailed effects the command's own words " +
        "do not state.",
      cannot_determine:
        "The command's words leave what it does unreadable — obfuscated, " +
        "dynamically assembled, or otherwise unstatable.",
    },
  },
  {
    id: "target",
    type: "choice",
    instructions:
      "What kind of thing does the action touch — ordinary files, credential " +
      "material, version history, or a system or service? Answer the kind " +
      "alone: where it sits belongs to the record's paths, not to this " +
      "reading. A command that operates on no file, repository, or service " +
      "reads `none`.",
    labels: TARGET_LABELS,
    criteria: {
      ordinary_files:
        "Ordinary files or directories — neither credential material nor " +
        "version history. A scratch note and a source file share this kind.",
      credential_material:
        "A path or name showing a secret, token, key, or credential store — " +
        "a private key file, a credential store, a token or password in a " +
        "variable or config.",
      vcs_history:
        "The repository's commits, branches, or references — what version control recorded.",
      system_or_service:
        "A running service, an installed package, kernel or system settings, or a device.",
      none: "The command operates on no file, repository, or service.",
      cannot_determine: "The record leaves what kind of thing the action touches undetermined.",
    },
  },
  {
    id: "intent",
    type: "choice",
    instructions:
      "Did the trusted request name this action, with the command staying " +
      "inside what the request named? Extra files, stronger flags, and " +
      "chained extra commands exceed the named scope.",
    labels: INTENT_LABELS,
    criteria: {
      requested:
        "The request named this action, and the command stays inside what " +
        "the request named — the same objects, the same range, no added steps.",
      not_requested:
        "The request did not name this action, or the command exceeds what " +
        "the request named. The named part authorizes only itself: the " +
        "exceeding part still needs its own naming.",
      cannot_determine:
        "The request itself is unclear, or the command reads unclear, so " +
        "whether the request named this action cannot be told.",
    },
  },
];
