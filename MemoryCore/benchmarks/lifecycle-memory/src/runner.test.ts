import { describe, expect, it } from "vitest";
import { oracleChainCandidates } from "./runner.js";
import type { LifecycleEvalQuestion, RetrievedUnit } from "./types.js";

function unit(id: string, sessionId: string, sequence: number, content: string): RetrievedUnit {
  return {
    id,
    sessionId,
    sequence,
    content,
    role: "user",
    timestampMs: sequence,
    score: 1,
    tokenCount: content.split(/\s+/).length,
  };
}

describe("oracle version-chain traversal", () => {
  it("replaces a stale predecessor with its correction event", () => {
    const question = {
      obsoleteAtoms: [{
        id: "q:obsolete:0",
        value: "period piece",
        sourceSessionIds: ["20"],
        invalidatedAtSequence: 20,
      }],
      currentAtoms: [{
        id: "q:current:0",
        value: "war drama",
        sourceSessionIds: ["20"],
      }],
    } as LifecycleEvalQuestion;
    const old = unit("old", "10", 10, "I enjoy period piece movies.");
    const filler = unit("filler", "30", 30, "I dislike musicals.");
    const correction = unit("correction", "20", 20, "I used to like period piece films; now I prefer war drama.");

    const result = oracleChainCandidates(question, [old, filler], new Map([["20", [correction]]]));

    expect(result.map((candidate) => candidate.id)).toEqual(["correction", "filler"]);
  });

  it("follows repeated corrections to the latest node", () => {
    const question = {
      obsoleteAtoms: [
        {
          id: "q:obsolete:0",
          value: "period piece",
          sourceSessionIds: ["20"],
          invalidatedAtSequence: 20,
        },
        {
          id: "q:obsolete:1",
          value: "war drama",
          sourceSessionIds: ["30"],
          invalidatedAtSequence: 30,
        },
      ],
      currentAtoms: [{
        id: "q:current:0",
        value: "documentary",
        sourceSessionIds: ["30"],
      }],
    } as LifecycleEvalQuestion;
    const old = unit("old", "10", 10, "I enjoy period piece movies.");
    const firstCorrection = unit(
      "first-correction",
      "20",
      20,
      "I used to like period piece films; now I prefer war drama.",
    );
    const latestCorrection = unit(
      "latest-correction",
      "30",
      30,
      "I am no longer interested in war drama; now I prefer documentaries.",
    );

    const result = oracleChainCandidates(question, [old], new Map([
      ["20", [firstCorrection]],
      ["30", [latestCorrection]],
    ]));

    expect(result.map((candidate) => candidate.id)).toEqual(["latest-correction"]);
  });
});
