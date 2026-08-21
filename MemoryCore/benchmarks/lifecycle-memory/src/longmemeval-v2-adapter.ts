import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import type {
  LongTaskDatasetAdapter,
  LongTaskDatasetDescription,
  LongTaskQuestion,
  LongTaskState,
  LongTaskTrajectory,
} from "./long-task-adapter.js";

interface RawQuestion {
  id: unknown;
  domain: unknown;
  environment: unknown;
  question_type: unknown;
  question: unknown;
  image: unknown;
  answer: unknown;
  eval_function: unknown;
}

interface RawState {
  state_index: unknown;
  step: unknown;
  url: unknown;
  action: unknown;
  thought: unknown;
  accessibility_tree: unknown;
  screenshot: unknown;
}

interface RawTrajectory {
  id: unknown;
  domain: unknown;
  environment: unknown;
  goal: unknown;
  outcome: unknown;
  start_url: unknown;
  states: unknown;
}

export interface LongMemEvalV2SnapshotExpectation {
  questionsSha256?: string;
  haystackSha256?: string;
  trajectoriesSha256?: string;
  questions?: number;
  trajectoryRows?: number;
  haystackSize?: number;
  selectedTrajectories?: number;
}

export interface LongMemEvalV2AdapterOptions {
  dataRoot: string;
  revision: string;
  tier?: string;
  expected?: LongMemEvalV2SnapshotExpectation;
}

interface TrajectoryScan {
  trajectories: LongTaskTrajectory[];
  rows: number;
  sha256: string;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`LongMemEval-V2 ${field} must be a non-empty string`);
  }
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error(`LongMemEval-V2 ${field} must be a string or null`);
  return value.length === 0 ? null : value;
}

function integer(value: unknown, field: string): number {
  if (!Number.isInteger(value)) throw new Error(`LongMemEval-V2 ${field} must be an integer`);
  return value as number;
}

function countBy(values: readonly string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function manifestSha256(entries: Record<string, string>): string {
  const hash = createHash("sha256");
  for (const [name, digest] of Object.entries(entries).sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(`${digest}  ${name}\n`);
  }
  return hash.digest("hex");
}

function assertExpected(label: string, actual: string | number, expected: string | number | undefined): void {
  if (expected !== undefined && actual !== expected) {
    throw new Error(`LongMemEval-V2 ${label} mismatch: expected ${expected}, got ${actual}`);
  }
}

function mapState(raw: RawState, trajectoryId: string, position: number): LongTaskState {
  const stateIndex = integer(raw.state_index, `${trajectoryId}.states[${position}].state_index`);
  if (stateIndex !== position) {
    throw new Error(`LongMemEval-V2 ${trajectoryId} state order mismatch: ${stateIndex} != ${position}`);
  }
  const action = nullableString(raw.action, `${trajectoryId}.states[${position}].action`);
  if (position === 0 && action !== null) {
    throw new Error(`LongMemEval-V2 ${trajectoryId} initial state unexpectedly has an action`);
  }
  const step = raw.step === null || raw.step === undefined
    ? null
    : integer(raw.step, `${trajectoryId}.states[${position}].step`);
  return {
    id: `${trajectoryId}:${stateIndex}`,
    trajectoryId,
    index: stateIndex,
    sourceStep: step,
    url: requireString(raw.url, `${trajectoryId}.states[${position}].url`),
    observation: requireString(
      raw.accessibility_tree,
      `${trajectoryId}.states[${position}].accessibility_tree`,
    ),
    thought: nullableString(raw.thought, `${trajectoryId}.states[${position}].thought`),
    // The public records place the executed action on the destination state.
    transitionAction: action,
    screenshotPath: nullableString(raw.screenshot, `${trajectoryId}.states[${position}].screenshot`),
  };
}

function mapTrajectory(raw: RawTrajectory): LongTaskTrajectory {
  const id = requireString(raw.id, "trajectory.id");
  if (!Array.isArray(raw.states) || raw.states.length === 0) {
    throw new Error(`LongMemEval-V2 ${id} must contain at least one state`);
  }
  return {
    id,
    domain: requireString(raw.domain, `${id}.domain`),
    environment: requireString(raw.environment, `${id}.environment`),
    goal: requireString(raw.goal, `${id}.goal`),
    outcome: requireString(raw.outcome, `${id}.outcome`),
    startUrl: requireString(raw.start_url, `${id}.start_url`),
    states: raw.states.map((state, index) => mapState(state as RawState, id, index)),
  };
}

export class LongMemEvalV2Adapter implements LongTaskDatasetAdapter {
  readonly name = "LongMemEval-V2";
  readonly revision: string;
  readonly tier: string;
  private readonly dataRoot: string;
  private readonly expected: LongMemEvalV2SnapshotExpectation;

  constructor(options: LongMemEvalV2AdapterOptions) {
    this.dataRoot = path.resolve(options.dataRoot);
    this.revision = options.revision;
    this.tier = options.tier ?? "small";
    this.expected = options.expected ?? {};
    if (!this.revision.trim()) throw new Error("LongMemEval-V2 revision must be non-empty");
    if (!/^[a-z0-9_-]+$/i.test(this.tier)) throw new Error(`invalid LongMemEval-V2 tier ${this.tier}`);
  }

  private questionsPath(): string {
    return path.join(this.dataRoot, "questions.jsonl");
  }

  private trajectoriesPath(): string {
    return path.join(this.dataRoot, "trajectories.jsonl");
  }

  private haystackPath(): string {
    return path.join(this.dataRoot, "haystacks", `lme_v2_${this.tier}.json`);
  }

  private async readHaystacks(): Promise<Record<string, string[]>> {
    const parsed = JSON.parse(await readFile(this.haystackPath(), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("LongMemEval-V2 haystack file must be an object");
    }
    const result: Record<string, string[]> = {};
    for (const [questionId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) {
        throw new Error(`LongMemEval-V2 haystack ${questionId} must be a non-empty string array`);
      }
      if (value.length === 0 || new Set(value).size !== value.length) {
        throw new Error(`LongMemEval-V2 haystack ${questionId} is empty or contains duplicate ids`);
      }
      assertExpected(`${questionId} haystack size`, value.length, this.expected.haystackSize);
      result[questionId] = [...value];
    }
    return result;
  }

  async loadQuestions(): Promise<LongTaskQuestion[]> {
    const haystacks = await this.readHaystacks();
    const questions: LongTaskQuestion[] = [];
    const ids = new Set<string>();
    const input = createReadStream(this.questionsPath(), { encoding: "utf8" });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      const raw = JSON.parse(line) as RawQuestion;
      const id = requireString(raw.id, "question.id");
      if (ids.has(id)) throw new Error(`duplicate LongMemEval-V2 question id ${id}`);
      ids.add(id);
      const trajectoryIds = haystacks[id];
      if (!trajectoryIds) throw new Error(`LongMemEval-V2 question ${id} has no ${this.tier} haystack`);
      questions.push({
        id,
        domain: requireString(raw.domain, `${id}.domain`),
        environment: requireString(raw.environment, `${id}.environment`),
        memoryAbility: requireString(raw.question_type, `${id}.question_type`),
        prompt: requireString(raw.question, `${id}.question`),
        referenceAnswer: requireString(raw.answer, `${id}.answer`),
        evaluator: requireString(raw.eval_function, `${id}.eval_function`),
        imagePath: nullableString(raw.image, `${id}.image`),
        trajectoryIds,
      });
    }
    const orphanHaystacks = Object.keys(haystacks).filter((id) => !ids.has(id));
    if (orphanHaystacks.length > 0) {
      throw new Error(`LongMemEval-V2 has ${orphanHaystacks.length} orphan ${this.tier} haystacks`);
    }
    assertExpected("question count", questions.length, this.expected.questions);
    return questions.sort((left, right) => left.id.localeCompare(right.id));
  }

  private async scanTrajectories(ids: ReadonlySet<string>): Promise<TrajectoryScan> {
    const trajectories: LongTaskTrajectory[] = [];
    const selected = new Set<string>();
    const input = createReadStream(this.trajectoriesPath(), { encoding: "utf8" });
    const hash = createHash("sha256");
    input.on("data", (chunk) => hash.update(chunk));
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    let rows = 0;
    for await (const line of lines) {
      if (!line.trim()) continue;
      rows += 1;
      const match = /^\s*\{\s*"id"\s*:\s*"([^"]+)"/.exec(line);
      if (!match) throw new Error(`LongMemEval-V2 trajectory row ${rows} does not start with an id`);
      if (!ids.has(match[1])) continue;
      if (selected.has(match[1])) throw new Error(`duplicate LongMemEval-V2 trajectory id ${match[1]}`);
      const trajectory = mapTrajectory(JSON.parse(line) as RawTrajectory);
      if (trajectory.id !== match[1]) throw new Error(`LongMemEval-V2 trajectory id scan mismatch on row ${rows}`);
      selected.add(trajectory.id);
      trajectories.push(trajectory);
    }
    const missing = [...ids].filter((id) => !selected.has(id));
    if (missing.length > 0) throw new Error(`LongMemEval-V2 missing ${missing.length} selected trajectories`);
    return {
      trajectories: trajectories.sort((left, right) => left.id.localeCompare(right.id)),
      rows,
      sha256: hash.digest("hex"),
    };
  }

  async loadTrajectories(ids: readonly string[]): Promise<LongTaskTrajectory[]> {
    const unique = new Set(ids);
    if (unique.size !== ids.length) throw new Error("LongMemEval-V2 requested trajectory ids contain duplicates");
    return (await this.scanTrajectories(unique)).trajectories;
  }

  async describe(): Promise<LongTaskDatasetDescription> {
    const questions = await this.loadQuestions();
    const selectedIds = [...new Set(questions.flatMap((question) => question.trajectoryIds))].sort();
    assertExpected("selected trajectory count", selectedIds.length, this.expected.selectedTrajectories);
    const [questionSha256, haystackSha256, scan] = await Promise.all([
      sha256File(this.questionsPath()),
      sha256File(this.haystackPath()),
      this.scanTrajectories(new Set(selectedIds)),
    ]);
    assertExpected("questions SHA-256", questionSha256, this.expected.questionsSha256);
    assertExpected("haystack SHA-256", haystackSha256, this.expected.haystackSha256);
    assertExpected("trajectories SHA-256", scan.sha256, this.expected.trajectoriesSha256);
    assertExpected("trajectory row count", scan.rows, this.expected.trajectoryRows);

    const byId = new Map(scan.trajectories.map((trajectory) => [trajectory.id, trajectory]));
    for (const question of questions) {
      for (const trajectoryId of question.trajectoryIds) {
        const trajectory = byId.get(trajectoryId);
        if (!trajectory) throw new Error(`LongMemEval-V2 unresolved trajectory ${trajectoryId}`);
        if (trajectory.domain !== question.domain) {
          throw new Error(`LongMemEval-V2 domain mismatch for ${question.id} and ${trajectoryId}`);
        }
      }
    }
    const states = scan.trajectories.flatMap((trajectory) => trajectory.states);
    const sourceSha256 = {
      [`haystacks/lme_v2_${this.tier}.json`]: haystackSha256,
      "questions.jsonl": questionSha256,
      "trajectories.jsonl": scan.sha256,
    };
    const sharedHaystacks = new Set(questions.map((question) => question.trajectoryIds.join("\0"))).size;
    return {
      name: this.name,
      revision: this.revision,
      tier: this.tier,
      manifestSha256: manifestSha256(sourceSha256),
      questions: questions.length,
      textOnlyQuestions: questions.filter((question) => question.imagePath === null).length,
      questionTypes: countBy(questions.map((question) => question.memoryAbility)),
      trajectoryRows: scan.rows,
      selectedTrajectories: scan.trajectories.length,
      sharedHaystacks,
      states: states.length,
      observationCharacters: states.reduce((sum, state) => sum + state.observation.length, 0),
      thoughtCharacters: states.reduce((sum, state) => sum + (state.thought?.length ?? 0), 0),
      actionCharacters: states.reduce((sum, state) => sum + (state.transitionAction?.length ?? 0), 0),
      emptyObservationStates: states.filter((state) => state.observation.trim().length === 0).length,
      initialStatesWithAction: scan.trajectories.filter(
        (trajectory) => trajectory.states[0]?.transitionAction !== null,
      ).length,
      trajectoryDomains: countBy(scan.trajectories.map((trajectory) => trajectory.domain)),
      trajectoryEnvironments: countBy(scan.trajectories.map((trajectory) => trajectory.environment)),
      outcomes: countBy(scan.trajectories.map((trajectory) => trajectory.outcome)),
      sourceSha256,
    };
  }
}
