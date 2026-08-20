import { describe, expect, it } from "vitest";
import {
  candidateMatchesCurrentAtom,
  candidateMatchesObsoleteAtom,
  redactObsoleteUnits,
} from "./semantics.js";
import type { EvidenceAtom } from "./types.js";

const deletedPreference: EvidenceAtom = {
  id: "q:obsolete:0",
  value: "period piece",
  sourceSessionIds: ["346"],
  invalidatedAtSequence: 346,
};

describe("lifecycle evidence semantics", () => {
  it("marks the old assertion, not the later correction event, as obsolete", () => {
    expect(candidateMatchesObsoleteAtom({
      content: "I enjoy a good period piece movie.",
      sequence: 234,
    }, deletedPreference)).toBe(true);

    expect(candidateMatchesObsoleteAtom({
      content: "I used to like period pieces, but I am not into them anymore.",
      sequence: 346,
    }, deletedPreference)).toBe(false);
  });

  it("redacts an obsolete value only before its invalidation boundary", () => {
    const units = [
      { content: "I enjoy a period piece.", sequence: 234 },
      { content: "I no longer enjoy a period piece.", sequence: 346 },
    ];
    expect(redactObsoleteUnits(units, [deletedPreference])).toEqual([
      { content: "I enjoy a .", sequence: 234 },
      units[1],
    ]);
  });

  it("keeps source provenance for current evidence", () => {
    const current: EvidenceAtom = {
      id: "q:current:0",
      value: "war drama",
      sourceSessionIds: ["1955"],
    };
    expect(candidateMatchesCurrentAtom({
      content: "I really like war drama movies.",
      sessionId: "1955",
    }, current)).toBe(true);
    expect(candidateMatchesCurrentAtom({
      content: "I really like war drama movies.",
      sessionId: "1869",
    }, current)).toBe(false);
  });
});
