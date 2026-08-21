import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LongMemEvalV2Adapter } from "./longmemeval-v2-adapter.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "longmemeval-v2-adapter-"));
  roots.push(root);
  await mkdir(path.join(root, "haystacks"));
  const questions = [
    {
      id: "q1",
      domain: "enterprise",
      environment: "fixture",
      question_type: "dynamic-environment",
      question: "What changed?",
      image: null,
      answer: "Enabled",
      eval_function: "norm_phrase_set_match",
    },
    {
      id: "q2",
      domain: "enterprise",
      environment: "fixture",
      question_type: "dynamic-environment-abs",
      question: "What did not change?",
      image: null,
      answer: "Nothing",
      eval_function: "llm_abstention_checker",
    },
  ];
  const trajectory = {
    id: "t1",
    domain: "enterprise",
    environment: "fixture",
    goal: "Enable the feature",
    outcome: "success",
    start_url: "https://example.test/",
    states: [
      {
        state_index: 0,
        step: 0,
        url: "https://example.test/",
        action: null,
        thought: "Open settings",
        accessibility_tree: "button Settings",
        screenshot: "screenshots/t1/0.png",
      },
      {
        state_index: 1,
        step: 1,
        url: "https://example.test/settings",
        action: "click('Settings')",
        thought: "Feature is enabled",
        accessibility_tree: "checkbox Feature checked=true",
        screenshot: "screenshots/t1/1.png",
      },
    ],
  };
  await Promise.all([
    writeFile(path.join(root, "questions.jsonl"), `${questions.map(JSON.stringify).join("\n")}\n`),
    writeFile(path.join(root, "trajectories.jsonl"), `${JSON.stringify(trajectory)}\n`),
    writeFile(path.join(root, "haystacks", "lme_v2_small.json"), JSON.stringify({ q1: ["t1"], q2: ["t1"] })),
  ]);
  return root;
}

describe("LongMemEval-V2 adapter", () => {
  it("normalizes destination-state actions behind a dataset-neutral boundary", async () => {
    const root = await fixtureRoot();
    const adapter = new LongMemEvalV2Adapter({
      dataRoot: root,
      revision: "fixture",
      expected: { questions: 2, trajectoryRows: 1, haystackSize: 1, selectedTrajectories: 1 },
    });
    const questions = await adapter.loadQuestions();
    const trajectories = await adapter.loadTrajectories(questions[0].trajectoryIds);
    expect(questions[0]).toMatchObject({
      memoryAbility: "dynamic-environment",
      referenceAnswer: "Enabled",
      trajectoryIds: ["t1"],
    });
    expect(trajectories[0].states.map((state) => state.transitionAction)).toEqual([
      null,
      "click('Settings')",
    ]);
  });

  it("audits shared haystacks, source hashes, and aggregate costs", async () => {
    const root = await fixtureRoot();
    const adapter = new LongMemEvalV2Adapter({
      dataRoot: root,
      revision: "fixture",
      expected: { questions: 2, trajectoryRows: 1, haystackSize: 1, selectedTrajectories: 1 },
    });
    const description = await adapter.describe();
    expect(description).toMatchObject({
      questions: 2,
      textOnlyQuestions: 2,
      trajectoryRows: 1,
      selectedTrajectories: 1,
      sharedHaystacks: 1,
      states: 2,
      emptyObservationStates: 0,
      initialStatesWithAction: 0,
      trajectoryDomains: { enterprise: 1 },
      outcomes: { success: 1 },
    });
    expect(description.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(description.sourceSha256["trajectories.jsonl"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fails closed when a haystack references a missing trajectory", async () => {
    const root = await fixtureRoot();
    await writeFile(
      path.join(root, "haystacks", "lme_v2_small.json"),
      JSON.stringify({ q1: ["missing"], q2: ["missing"] }),
    );
    const adapter = new LongMemEvalV2Adapter({ dataRoot: root, revision: "fixture" });
    await expect(adapter.describe()).rejects.toThrow("missing 1 selected trajectories");
  });
});
