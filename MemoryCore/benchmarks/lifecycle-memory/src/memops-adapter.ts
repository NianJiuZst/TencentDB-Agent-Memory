import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { MemoryUnit } from "./types.js";

export type MemOpsOperationType = "remember" | "forget" | "update" | "reflect";
export type MemOpsValidity = "confirmed" | "tentative" | "retracted";

export interface MemOpsSpan {
  quote: string;
  segment_index: number;
  turn_index: number;
}

export interface MemOpsOperation {
  chain_id?: string;
  chain_step?: number;
  evidence_spans: MemOpsSpan[];
  new_value: string | null;
  old_value: string | null;
  operation_id: string;
  target: {
    target_id: string;
    target_name: string;
  };
  trigger_span: MemOpsSpan;
  type: MemOpsOperationType;
  validity: MemOpsValidity;
}

export interface MemOpsProbe {
  diagnostic_checks: Record<string, string | null>;
  difficulty: string;
  evaluation_category: string;
  evaluation_setting: "adjacent_operation" | "longitudinal_operation";
  evaluation_type: string;
  expected_answer: string;
  gold_memory_state: string;
  gold_provenance: MemOpsSpan[];
  judge_rubric: {
    acceptable_paraphrases: string[];
    harmful_extra: string[];
    harmless_extra: string[];
    must_include: string[];
    must_not_include: string[];
  };
  question: string;
  question_pair_id: string;
  [key: string]: unknown;
}

interface MemOpsEvidenceFile {
  answer: MemOpsProbe[];
  conversations: Array<Record<string, unknown>>;
  difficulty_knobs: Record<string, unknown>;
  operation_type: string;
  operations: MemOpsOperation[];
  target_fact: string;
}

interface InjectedTurn {
  content: string;
  role: "user" | "assistant";
}

interface InjectedConversation {
  dialogue: InjectedTurn[];
  evidence_inserted: boolean;
  evidence_segment_index: number | null;
  insertion_index: number | null;
  segment_index: number;
  [key: string]: unknown;
}

interface MemOpsInjectedFile {
  answer: MemOpsProbe[];
  conversations: InjectedConversation[];
  injection_metadata: Record<string, unknown>;
  operation_type: string;
  target_fact: string;
}

export interface MemOpsMappedOperation extends MemOpsOperation {
  evidenceUnitIds: string[];
  triggerUnitId: string;
  triggerSequence: number;
}

export interface MemOpsMappedProbe extends MemOpsProbe {
  goldProvenanceUnitIds: string[];
  id: string;
}

export interface MemOpsInstance {
  difficultyKnobs: Record<string, unknown>;
  id: string;
  operationFamily: string;
  operations: MemOpsMappedOperation[];
  probes: MemOpsMappedProbe[];
  profileId: string;
  targetFact: string;
  units: MemoryUnit[];
}

export interface MemOpsDatasetDescription {
  evidenceFiles: number;
  injectedFiles: number;
  instances: number;
  longitudinalProbes: number;
  manifestSha256: string;
  name: "MemOps";
  operationCounts: Record<string, number>;
  operations: number;
  profiles: number;
  revision: string;
}

const EVIDENCE_DIRECTORY = "2-evidence_conversation";
const INJECTED_DIRECTORY = "4-inject_evidence_with_distractors";

function normalize(value: string): string {
  return value.toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function unitId(instanceId: string, segmentIndex: number, turnIndex: number): string {
  return `${instanceId}:${segmentIndex}:${turnIndex}`;
}

function profileId(instanceId: string): string {
  const matched = /^([A-Z]\d+)_/.exec(instanceId);
  if (!matched) throw new Error(`invalid MemOps instance id ${instanceId}`);
  return matched[1];
}

async function listJsonNames(directory: string): Promise<string[]> {
  return (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
}

function findSpanUnitId(params: {
  conversations: InjectedConversation[];
  instanceId: string;
  span: MemOpsSpan;
}): string {
  const quote = normalize(params.span.quote);
  const evidenceSegments = params.conversations.filter((conversation) =>
    conversation.evidence_inserted
    && conversation.evidence_segment_index === params.span.segment_index
  );
  if (evidenceSegments.length !== 1) {
    throw new Error(
      `MemOps span mapping expected one evidence segment for ${params.instanceId}`
      + ` segment ${params.span.segment_index}, found ${evidenceSegments.length}`,
    );
  }
  const evidenceSegment = evidenceSegments[0];
  if (evidenceSegment.insertion_index !== null) {
    const expectedTurnIndex = evidenceSegment.insertion_index + params.span.turn_index - 1;
    const expectedTurn = evidenceSegment.dialogue[expectedTurnIndex];
    if (expectedTurn && normalize(expectedTurn.content).includes(quote)) {
      return unitId(params.instanceId, evidenceSegment.segment_index, expectedTurnIndex);
    }
  }
  const exactMatches = evidenceSegments.flatMap((conversation) =>
    conversation.dialogue.map((turn, turnIndex) => ({ conversation, turn, turnIndex }))
  ).filter(({ turn }) => normalize(turn.content).includes(quote));
  const userMatches = exactMatches.filter(({ turn }) => turn.role === "user");
  const matches = userMatches.length === 1 ? userMatches : exactMatches;
  if (matches.length !== 1) {
    throw new Error(
      `MemOps span mapping expected one match for ${params.instanceId}`
      + ` segment ${params.span.segment_index}, found ${matches.length}: ${params.span.quote}`,
    );
  }
  const matched = matches[0];
  return unitId(params.instanceId, matched.conversation.segment_index, matched.turnIndex);
}

export async function listMemOpsInstanceIds(dataRoot: string): Promise<string[]> {
  const evidenceNames = await listJsonNames(path.join(dataRoot, EVIDENCE_DIRECTORY));
  const injectedNames = await listJsonNames(path.join(dataRoot, INJECTED_DIRECTORY));
  if (evidenceNames.join("\0") !== injectedNames.join("\0")) {
    throw new Error("MemOps evidence and longitudinal file sets differ");
  }
  return evidenceNames.map((name) => name.replace(/\.json$/, ""));
}

export async function loadMemOpsInstance(
  dataRoot: string,
  instanceId: string,
): Promise<MemOpsInstance> {
  const [evidenceText, injectedText] = await Promise.all([
    readFile(path.join(dataRoot, EVIDENCE_DIRECTORY, `${instanceId}.json`), "utf8"),
    readFile(path.join(dataRoot, INJECTED_DIRECTORY, `${instanceId}.json`), "utf8"),
  ]);
  const evidence = JSON.parse(evidenceText) as MemOpsEvidenceFile;
  const injected = JSON.parse(injectedText) as MemOpsInjectedFile;
  if (evidence.operation_type !== injected.operation_type
    || evidence.target_fact !== injected.target_fact) {
    throw new Error(`MemOps paired file mismatch for ${instanceId}`);
  }
  const evidenceAnswers = evidence.answer.filter((item) =>
    item.evaluation_setting === "longitudinal_operation"
  );
  const injectedAnswers = injected.answer.filter((item) =>
    item.evaluation_setting === "longitudinal_operation"
  );
  if (JSON.stringify(evidenceAnswers) !== JSON.stringify(injectedAnswers)) {
    throw new Error(`MemOps answer mismatch for ${instanceId}`);
  }
  const units = injected.conversations.flatMap((conversation) =>
    conversation.dialogue.map((turn, turnIndex): MemoryUnit => {
      const sequence = conversation.segment_index * 10_000 + turnIndex;
      return {
        id: unitId(instanceId, conversation.segment_index, turnIndex),
        sessionId: String(conversation.segment_index),
        role: turn.role,
        content: turn.content.trim(),
        timestampMs: sequence * 1_000,
        sequence,
      };
    })
  );
  if (new Set(units.map((item) => item.id)).size !== units.length) {
    throw new Error(`duplicate MemOps unit id in ${instanceId}`);
  }
  const mappedOperations = evidence.operations.map((operation): MemOpsMappedOperation => {
    const triggerUnitId = findSpanUnitId({
      conversations: injected.conversations,
      instanceId,
      span: operation.trigger_span,
    });
    const trigger = units.find((item) => item.id === triggerUnitId)!;
    return {
      ...operation,
      triggerUnitId,
      triggerSequence: trigger.sequence,
      evidenceUnitIds: [...new Set(operation.evidence_spans.map((span) => findSpanUnitId({
        conversations: injected.conversations,
        instanceId,
        span,
      })))],
    };
  });
  const probes = injectedAnswers.map((probe): MemOpsMappedProbe => ({
    ...probe,
    id: `${instanceId}:${probe.question_pair_id}`,
    goldProvenanceUnitIds: [...new Set(probe.gold_provenance.map((span) => findSpanUnitId({
      conversations: injected.conversations,
      instanceId,
      span,
    })))],
  }));
  if (new Set(probes.map((item) => item.id)).size !== probes.length) {
    throw new Error(`duplicate MemOps longitudinal probe id in ${instanceId}`);
  }
  return {
    id: instanceId,
    profileId: profileId(instanceId),
    operationFamily: evidence.operation_type,
    targetFact: evidence.target_fact,
    difficultyKnobs: evidence.difficulty_knobs,
    units,
    operations: mappedOperations.sort((left, right) =>
      left.triggerSequence - right.triggerSequence
      || left.operation_id.localeCompare(right.operation_id)
    ),
    probes,
  };
}

export async function describeMemOpsDataset(params: {
  dataRoot: string;
  revision: string;
}): Promise<MemOpsDatasetDescription> {
  const ids = await listMemOpsInstanceIds(params.dataRoot);
  const hash = createHash("sha256");
  const profiles = new Set<string>();
  const operationCounts: Record<string, number> = {};
  let operations = 0;
  let longitudinalProbes = 0;
  for (const instanceId of ids) {
    for (const directory of [EVIDENCE_DIRECTORY, INJECTED_DIRECTORY]) {
      const relative = `${directory}/${instanceId}.json`;
      const contentHash = createHash("sha256")
        .update(await readFile(path.join(params.dataRoot, relative)))
        .digest("hex");
      hash.update(`${contentHash}  ./${relative}\n`);
    }
    const instance = await loadMemOpsInstance(params.dataRoot, instanceId);
    profiles.add(instance.profileId);
    operationCounts[instance.operationFamily]
      = (operationCounts[instance.operationFamily] ?? 0) + 1;
    operations += instance.operations.length;
    longitudinalProbes += instance.probes.length;
  }
  return {
    name: "MemOps",
    revision: params.revision,
    manifestSha256: hash.digest("hex"),
    instances: ids.length,
    profiles: profiles.size,
    evidenceFiles: ids.length,
    injectedFiles: ids.length,
    operations,
    longitudinalProbes,
    operationCounts,
  };
}
