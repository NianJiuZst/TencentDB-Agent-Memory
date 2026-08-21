import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { describeMemOpsDataset, loadMemOpsInstance } from "./memops-adapter.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "memops-adapter-"));
  roots.push(root);
  await Promise.all([
    mkdir(path.join(root, "2-evidence_conversation")),
    mkdir(path.join(root, "4-inject_evidence_with_distractors")),
  ]);
  const span = { segment_index: 1, turn_index: 1, quote: "Linda Zhao is the manager" };
  const probe = {
    question_pair_id: "p1",
    evaluation_setting: "longitudinal_operation",
    evaluation_type: "CandidateDisambiguation",
    evaluation_category: "candidate_disambiguation",
    difficulty: "medium",
    question: "Who is the manager?",
    expected_answer: "Linda Zhao",
    gold_memory_state: "Confirmed: Linda Zhao",
    judge_rubric: {
      must_include: ["Linda Zhao"],
      acceptable_paraphrases: [],
      must_not_include: [],
      harmful_extra: [],
      harmless_extra: [],
    },
    diagnostic_checks: {},
    gold_provenance: [span],
  };
  const common = {
    operation_type: "Remember",
    target_fact: "B04 manager",
  };
  const evidence = {
    ...common,
    difficulty_knobs: {},
    conversations: [],
    operations: [{
      operation_id: "op1",
      type: "remember",
      validity: "confirmed",
      trigger_span: span,
      target: { target_id: "manager", target_name: "manager" },
      old_value: null,
      new_value: "Linda Zhao",
      evidence_spans: [span],
    }],
    answer: [probe],
  };
  const injected = {
    ...common,
    injection_metadata: {},
    conversations: [{
      segment_index: 9,
      evidence_inserted: true,
      evidence_segment_index: 1,
      insertion_index: 2,
      dialogue: [
        { role: "user", content: "irrelevant" },
        { role: "assistant", content: "irrelevant reply" },
        { role: "user", content: "Linda Zhao is the manager of B04." },
        { role: "assistant", content: "Yes, Linda Zhao is the manager." },
      ],
    }],
    answer: [probe],
  };
  await Promise.all([
    writeFile(
      path.join(root, "2-evidence_conversation", "B04_remember.json"),
      JSON.stringify(evidence),
    ),
    writeFile(
      path.join(root, "4-inject_evidence_with_distractors", "B04_remember.json"),
      JSON.stringify(injected),
    ),
  ]);
  return root;
}

describe("MemOps adapter", () => {
  it("uses the gold 1-based turn index to disambiguate an assistant echo", async () => {
    const root = await fixtureRoot();
    const instance = await loadMemOpsInstance(root, "B04_remember");
    expect(instance.operations[0].triggerUnitId).toBe("B04_remember:9:2");
    expect(instance.probes[0].goldProvenanceUnitIds).toEqual(["B04_remember:9:2"]);
  });

  it("describes paired public artifacts without interpreting outcomes", async () => {
    const root = await fixtureRoot();
    const description = await describeMemOpsDataset({ dataRoot: root, revision: "fixture" });
    expect(description).toMatchObject({
      instances: 1,
      profiles: 1,
      longitudinalProbes: 1,
      operations: 1,
      operationCounts: { Remember: 1 },
    });
    expect(description.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
