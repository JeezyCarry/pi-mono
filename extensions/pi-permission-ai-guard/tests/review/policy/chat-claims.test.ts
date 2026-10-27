import { describe, expect, it } from "vitest";

import { parseChatClaims } from "#src/review/policy/chat-claims.ts";
import type { FactRuling } from "#src/review/policy/concepts.ts";
import { decidePolicy } from "#src/review/policy/decide.ts";
import { factTier } from "#src/review/policy/fact-tier.ts";

const OPTIONS = {
  confidenceThreshold: 0.5,
  facts: { commandEffect: "read", pathScope: "inside" } as never,
};

const ev = (concept: string, presence: string, confidence?: number) =>
  JSON.stringify({ concept, presence, ...(confidence === undefined ? {} : { confidence }) });
const reply = (...items: string[]) => `{"evidence":[${items.join(",")}]}`;

/** A free base (an in-workspace read), so claims are the only variable. */
const FREE_BASE: FactRuling = factTier({
  pathScope: "inside",
  commandEffect: "read",
  network: "none",
} as never);

const decide = (
  text: string,
  hasTrustedAnchor: boolean,
  base: FactRuling = FREE_BASE,
  complete = false,
) => {
  const parsed = parseChatClaims(text);
  if (!parsed) return null;
  return decidePolicy(
    {
      base,
      claims: parsed.claims,
      hasTrustedAnchor,
      laneUnresolved: false,
      completeness: complete ? "every-applicable-concept-answered" : "axes-are-mandatory",
    },
    OPTIONS,
  );
};

// A claims object under an arbitrary key spelling: the payload is a confirmed
// dangerous reading, so a parser that skips this object would release.
const dangerReply = (key: string) =>
  `{${key}:[{"concept":"persistence_install","presence":"confirmed","confidence":0.9}]}`;

describe("parseChatClaims", () => {
  it("parses a bare claim object", () => {
    const parsed = parseChatClaims(
      '{"evidence":[{"concept":"credential_exposure","presence":"confirmed","confidence":0.9}],"reason":"prints the key"}',
    );
    expect(parsed?.claims).toEqual([
      { concept: "credential_exposure", presence: "confirmed", confidence: 0.9 },
    ]);
    expect(parsed?.reason).toBe("prints the key");
  });

  it("extracts claims wrapped in prose", () => {
    expect(
      parseChatClaims(`Sure. ${reply(ev("other_read", "confirmed"))} done`)?.claims,
    ).toHaveLength(1);
  });

  it("fails the whole reply when any entry is invalid", () => {
    expect(
      parseChatClaims(reply(ev("not_a_concept", "confirmed"), ev("other_read", "confirmed"))),
    ).toBeNull();
    expect(
      parseChatClaims(reply(ev("other_read", "maybe"), ev("other_read", "confirmed"))),
    ).toBeNull();
  });

  it("drops an out-of-range confidence instead of clamping it up", () => {
    // A confidence the model got wrong is not trusted: dropped, so the core
    // reads the claim as unknown rather than fully confident.
    expect(
      parseChatClaims(reply(ev("other_read", "confirmed", 3)))?.claims[0]?.confidence,
    ).toBeUndefined();
    expect(
      parseChatClaims(reply(ev("other_read", "confirmed", -1)))?.claims[0]?.confidence,
    ).toBeUndefined();
    expect(parseChatClaims(reply(ev("other_read", "confirmed", 0.9)))?.claims[0]?.confidence).toBe(
      0.9,
    );
  });

  it("returns null without a usable claims array", () => {
    expect(parseChatClaims("no json here")).toBeNull();
    expect(parseChatClaims('{"verdict":"allow"}')).toBeNull();
    expect(parseChatClaims('{"evidence":[]}')).toBeNull();
  });

  it("selects the claims object by key, not by position", () => {
    // A model that prints an example verdict object before its structured
    // claims must not lose the claims: the reader looks for `evidence`.
    const parsed = parseChatClaims(
      `{"verdict":"allow"} ${reply(ev("other_read", "confirmed", 0.9))}`,
    );
    expect(parsed?.claims).toHaveLength(1);
  });

  it("still fails closed when the claims object is malformed or contradicts itself", () => {
    // Selecting by key must not become "skip the broken object": a malformed
    // claims object defers rather than letting a later, weaker one decide.
    expect(
      parseChatClaims(
        `${reply(ev("not_a_concept", "confirmed"))} ${reply(ev("other_read", "confirmed"))}`,
      ),
    ).toBeNull();
    expect(
      parseChatClaims('{"evidence":[{"concept":"other_read","presence":"maybe"}]}'),
    ).toBeNull();
  });

  it("treats a wrong-typed evidence value as a broken claims object, not as noise", () => {
    // The `evidence` KEY names the object even when its value is wrong.
    // Treating a non-array as noise would skip the broken object and let a
    // later one decide an ask the model answered badly.
    expect(
      parseChatClaims(`{"evidence":"bad"} ${reply(ev("other_read", "confirmed", 0.9))}`),
    ).toBeNull();
    expect(
      parseChatClaims(`${reply(ev("other_read", "confirmed", 0.9))} {"evidence":"bad"}`),
    ).toBeNull();
    expect(parseChatClaims('{"evidence":null}')).toBeNull();
  });

  it("treats a cut-off claims attempt as broken, before or after a valid one", () => {
    // An unbalanced `{"evidence"` — no colon — is still a claims attempt. A
    // probe that required the colon would skip it and let a later object rescue
    // a reply the model failed to produce.
    expect(parseChatClaims(`{"evidence" ${reply(ev("other_read", "confirmed", 0.9))}`)).toBeNull();
    expect(parseChatClaims(`${reply(ev("other_read", "confirmed", 0.9))} {"evidence"`)).toBeNull();
  });

  it("treats a claims attempt as broken however the keys are ordered", () => {
    // `evidence` is not the first key, so a probe anchored at the opening brace
    // would skip the broken object and let the later one decide the ask.
    expect(
      parseChatClaims(`{"reason":"x","evidence" ${reply(ev("other_read", "confirmed", 0.9))}`),
    ).toBeNull();
    expect(
      parseChatClaims(`${reply(ev("other_read", "confirmed", 0.9))} {"reason":"x","evidence"`),
    ).toBeNull();
  });

  it("does not read a longer key as the claims key", () => {
    // `evidenceMore` is a different key. A broken object carrying only that is
    // brace noise, so a real claims object after it still parses.
    const parsed = parseChatClaims(
      `{"evidenceMore":1, bad} ${reply(ev("other_read", "confirmed", 0.9))}`,
    );
    expect(parsed?.claims).toHaveLength(1);
  });

  it("is not fooled by the key name inside a string value", () => {
    // `, evidence` here is string CONTENT. A probe that ignores string state
    // would reject the reply and discard a valid claims object.
    const broken = `{"reason":"x, evidence", bad}`;
    const valid = reply(ev("other_read", "confirmed", 0.9));
    expect(parseChatClaims(`${broken} ${valid}`)?.claims).toHaveLength(1);
    expect(parseChatClaims(`${valid} ${broken}`)?.claims).toHaveLength(1);
  });

  it("treats an attempt as broken when the comma before the key is missing", () => {
    // Missing member commas are common model drift. The broken attempt must
    // still stop the search rather than let the later object decide.
    const valid = reply(ev("other_read", "confirmed", 0.9));
    expect(parseChatClaims(`{"reason":"x" "evidence":1} ${valid}`)).toBeNull();
    expect(parseChatClaims(`${valid} {"reason":"x" "evidence":1}`)).toBeNull();
  });

  it("reads an escaped key as the claims key", () => {
    // `evi\u0064ence` decodes to `evidence`, so the object is still an attempt.
    const valid = reply(ev("other_read", "confirmed", 0.9));
    expect(parseChatClaims(`{"evi\\u0064ence":1, bad} ${valid}`)).toBeNull();
  });

  it("reads a shouted key as the claims key", () => {
    // The key comparison is case-insensitive, as the previous probes were.
    const valid = reply(ev("other_read", "confirmed", 0.9));
    expect(parseChatClaims(`{"EVIDENCE":1, bad} ${valid}`)).toBeNull();
  });

  it("reads a padded or C-style-escaped key as the claims key", () => {
    // Invisible padding and the `\xHH` spelling JSON cannot decode must not
    // hide the key: a hidden key would let a later object decide the ask.
    const valid = reply(ev("other_read", "confirmed", 0.9));
    expect(parseChatClaims(`{" evidence ":1, bad} ${valid}`)).toBeNull();
    expect(parseChatClaims(`{"evi\\x64ence":1, bad} ${valid}`)).toBeNull();
  });

  it("defers when a near-miss key stands beside the claims key", () => {
    // Recognition is tolerant, reading is exact: a padded, shouted or escaped
    // key names a claims attempt, so it must not be skipped in favour of the
    // later object — the claims it carries would be silently dropped.
    const benign = reply(ev("other_read", "absent", 0.9));
    for (const key of ['" evidence"', '"EVIDENCE"', '"evi\\u0064ence"']) {
      expect(parseChatClaims(`${dangerReply(key)} ${benign}`)).toBeNull();
      expect(parseChatClaims(`${benign} ${dangerReply(key)}`)).toBeNull();
    }
    // Two recognized keys in one object are ambiguous too.
    expect(
      parseChatClaims(
        `{"evidence":[{"concept":"other_read","presence":"absent","confidence":0.9}]," evidence":1}`,
      ),
    ).toBeNull();
  });

  it("registers the recognition boundary: only the ASCII letters are read", () => {
    // The probe reasons over unparseable text, so a key whose letters are not
    // ASCII is not recognized, and a later claims object still decides. Pinned
    // here so any change to that boundary shows up as a test change.
    const valid = reply(ev("other_read", "confirmed", 0.9));
    expect(parseChatClaims(`{"evİdence":1, bad} ${valid}`)?.claims).toHaveLength(1);
    expect(parseChatClaims(`{"reason":"x" "evidence"} ${valid}`)?.claims).toHaveLength(1);
    expect(parseChatClaims(`${valid} {"reason":"x" "evidence"}`)?.claims).toHaveLength(1);
  });
});

describe("chat claims through the core", () => {
  it("a danger claim tightens the base even on a named anchor", () => {
    expect(
      decide(
        reply(
          ev("persistence_install", "confirmed", 0.9),
          ev("authorization_anchor", "confirmed", 0.9),
        ),
        true,
      ),
    ).toMatchObject({ kind: "defer", lean: "deny", decidedBy: "persistence_install" });
  });

  it("a guard claim without the record anchor defers", () => {
    expect(decide(reply(ev("restricted_network_read", "confirmed", 0.9)), false)).toMatchObject({
      kind: "defer",
      lean: "deny",
    });
  });

  it("a sparse chat reply is incomplete, so a release defers", () => {
    const guardBase = factTier({
      pathScope: "outside",
      commandEffect: "read",
      network: "none",
    } as never);
    const anchor = reply(ev("authorization_anchor", "confirmed", 0.9));
    // Without completeness the named anchor releases.
    expect(decide(anchor, true, guardBase)).toMatchObject({ kind: "allow" });
    // Requiring completeness, the same reply cannot distinguish "no danger"
    // from "not checked", so it defers.
    expect(decide(anchor, true, guardBase, true)).toMatchObject({
      kind: "defer",
      lean: "deny",
      decidedBy: "credential_exposure",
    });
  });
});
