import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { getEncoding } from "js-tiktoken";
import { parseConfig } from "../../../src/config.js";
import { performAutoRecall, type RecallResult } from "../../../src/core/hooks/auto-recall.js";
import { appendLifecycleFeedbackEvent } from "../../../src/core/lifecycle/feedback-store.js";
import {
  clearGitMemoryVersionContextCache,
  detectGitMemoryVersionContext,
} from "../../../src/core/lifecycle/git-context.js";
import type { MemoryVersionContext } from "../../../src/core/lifecycle/version-scope.js";
import { writeMemory, type MemoryType } from "../../../src/core/record/l1-writer.js";
import { LocalStorageBackend } from "../../../src/core/storage/local-backend.js";
import { StorageAdapter } from "../../../src/core/storage/adapter.js";
import { VectorStore } from "../../../src/core/store/sqlite.js";
import { loadMemora } from "./adapter.js";
import { sourceRevision } from "./adaptive-runner.js";
import type { LifecycleEvalQuestion } from "./types.js";
import {
  VERSION_AWARE_CONTEXT_PROTOCOL,
  type VersionAwareArm,
  type VersionAwarePanel,
  type VersionAwareSlice,
} from "./version-aware-context-protocol.js";

const execFileAsync = promisify(execFile);
const encoding = getEncoding("cl100k_base");
const TEAM_ID = "version-aware-eval";
const AGENT_ID = "memory-reader";
const USER_ID = "version-agent";
const SESSION_KEY = "version-aware-production-session";

export interface VersionAwareReaderMessage {
  role: "system" | "user";
  content: string;
}

interface PriorContext {
  hash: string;
  caseId: string;
  prependContext: string;
  recalledMemories: Array<{ id?: string; content: string; score: number; type: string }>;
}

interface PriorCase {
  caseId: string;
  panel: string;
  persona: string;
  arms: Record<string, string>;
}

interface PriorManifest {
  cases: PriorCase[];
  contexts: PriorContext[];
}

interface ScenarioDefinition {
  id: string;
  facet: string;
  mainValue: string;
  releaseValue: string;
  worktreeAValue: string;
  worktreeBValue: string;
  taskAValue: string;
  taskBValue: string;
}

interface FixtureContexts {
  mainBranch: MemoryVersionContext;
  releaseBranch: MemoryVersionContext;
  worktreeA: MemoryVersionContext;
  worktreeB: MemoryVersionContext;
  taskA: MemoryVersionContext;
  taskB: MemoryVersionContext;
}

interface FixtureInfo {
  root: string;
  primary: string;
  release: string;
  worktreeA: string;
  worktreeB: string;
  mainCommit: string;
  releaseCommit: string;
  contexts: FixtureContexts;
  scenarios: ScenarioDefinition[];
}

export interface VersionAwareContextEntry {
  hash: string;
  caseId: string;
  messages: VersionAwareReaderMessage[];
  prependContext: string;
  appendSystemContext: string;
  injectedTokens: number;
  recalledMemoryIds: string[];
  recalledMemories: Array<{ id?: string; content: string; score: number; type: string }>;
  lifecycleMode: "base" | "adaptive" | "fallback" | "none";
  versionScopeStatus?: string;
  versionIntent?: string;
  versionSuppressedCandidates: number;
  versionLabeledStates: number;
  elapsedMs: number;
}

export interface VersionAwareManifestCase {
  caseId: string;
  panel: VersionAwarePanel;
  slice: VersionAwareSlice;
  groupId: string;
  persona: string;
  task: string;
  question: LifecycleEvalQuestion;
  expectedVersionAwareMemoryIds: string[];
  arms: Record<VersionAwareArm, string>;
}

export interface VersionAwareContextOptions {
  dataRoot: string;
  priorContextManifest: string;
  outputDir: string;
  fixtureRoot: string;
  skipHashVerification?: boolean;
}

const SCENARIOS: ScenarioDefinition[] = [
  { id: "atlas-test", facet: "focused test command", mainValue: "pnpm test atlas:unit", releaseValue: "npm run test:atlas-legacy", worktreeAValue: "pnpm vitest atlas-a", worktreeBValue: "pnpm vitest atlas-b", taskAValue: "pnpm test task-alpha", taskBValue: "pnpm test task-beta" },
  { id: "beacon-config", facet: "cache default", mainValue: "write-through", releaseValue: "read-through", worktreeAValue: "cache-off", worktreeBValue: "cache-local", taskAValue: "cache-alpha", taskBValue: "cache-beta" },
  { id: "cobalt-api", facet: "health API path", mainValue: "/api/v3/health", releaseValue: "/api/v2/status", worktreeAValue: "/scratch/a/health", worktreeBValue: "/scratch/b/health", taskAValue: "/task/alpha/health", taskBValue: "/task/beta/health" },
  { id: "delta-flag", facet: "feature flag", mainValue: "DELTA_STREAM_V2", releaseValue: "DELTA_STREAM_LEGACY", worktreeAValue: "DELTA_WT_A", worktreeBValue: "DELTA_WT_B", taskAValue: "DELTA_TASK_ALPHA", taskBValue: "DELTA_TASK_BETA" },
  { id: "ember-schema", facet: "account status column", mainValue: "lifecycle_state", releaseValue: "account_status", worktreeAValue: "state_wt_a", worktreeBValue: "state_wt_b", taskAValue: "state_task_alpha", taskBValue: "state_task_beta" },
  { id: "fjord-runtime", facet: "Node runtime", mainValue: "Node 24", releaseValue: "Node 20", worktreeAValue: "Node 22-wt-a", worktreeBValue: "Node 22-wt-b", taskAValue: "Node 23-alpha", taskBValue: "Node 23-beta" },
  { id: "grove-build", facet: "release build target", mainValue: "bundle:esm", releaseValue: "bundle:cjs", worktreeAValue: "bundle:wt-a", worktreeBValue: "bundle:wt-b", taskAValue: "bundle:alpha", taskBValue: "bundle:beta" },
  { id: "harbor-port", facet: "service port", mainValue: "9443", releaseValue: "8443", worktreeAValue: "7443", worktreeBValue: "7444", taskAValue: "7543", taskBValue: "7544" },
  { id: "iris-path", facet: "generated client path", mainValue: "src/generated/v3", releaseValue: "src/generated/v2", worktreeAValue: "tmp/generated/a", worktreeBValue: "tmp/generated/b", taskAValue: "tasks/alpha/generated", taskBValue: "tasks/beta/generated" },
  { id: "juniper-timeout", facet: "request timeout", mainValue: "4500ms", releaseValue: "8000ms", worktreeAValue: "5100ms", worktreeBValue: "5200ms", taskAValue: "5300ms", taskBValue: "5400ms" }
];

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(fraction * (sorted.length - 1))];
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: "Version Memory Benchmark",
    GIT_AUTHOR_EMAIL: "version-memory@example.invalid",
    GIT_COMMITTER_NAME: "Version Memory Benchmark",
    GIT_COMMITTER_EMAIL: "version-memory@example.invalid",
    GIT_AUTHOR_DATE: "2026-08-31T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-08-31T00:00:00Z",
  };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    env: gitEnv(),
  });
  return result.stdout.trim();
}

async function writeScenarioFiles(root: string, field: keyof Pick<
  ScenarioDefinition,
  "mainValue" | "releaseValue" | "worktreeAValue" | "worktreeBValue"
>): Promise<void> {
  await mkdir(path.join(root, "states"), { recursive: true });
  for (const scenario of SCENARIOS) {
    await writeFile(path.join(root, "states", `${scenario.id}.json`), `${JSON.stringify({
      project: scenario.id,
      facet: scenario.facet,
      value: scenario[field],
    }, null, 2)}\n`, "utf8");
  }
}

async function buildGitFixture(root: string): Promise<FixtureInfo> {
  if (!root.startsWith("/tmp/tdai-version-aware-")) {
    throw new Error(`fixture root must be an explicit /tmp/tdai-version-aware-* path: ${root}`);
  }
  await rm(root, { recursive: true, force: true });
  const primary = path.join(root, "primary");
  const release = path.join(root, "release");
  const worktreeA = path.join(root, "worktree-a");
  const worktreeB = path.join(root, "worktree-b");
  await mkdir(primary, { recursive: true });
  await git(primary, ["init", "-b", "main"]);
  await writeScenarioFiles(primary, "mainValue");
  await mkdir(path.join(primary, "tasks"), { recursive: true });
  await writeFile(path.join(primary, "tasks", "parallel-states.json"), `${JSON.stringify(Object.fromEntries(
    SCENARIOS.map((scenario) => [scenario.id, { alpha: scenario.taskAValue, beta: scenario.taskBValue }]),
  ), null, 2)}\n`, "utf8");
  await git(primary, ["add", "."]);
  await git(primary, ["commit", "-m", "seed main version states"]);
  const mainCommit = await git(primary, ["rev-parse", "HEAD"]);
  await git(primary, ["branch", "release"]);
  await git(primary, ["worktree", "add", release, "release"]);
  await writeScenarioFiles(release, "releaseValue");
  await git(release, ["add", "states"]);
  await git(release, ["commit", "-m", "set release version states"]);
  const releaseCommit = await git(release, ["rev-parse", "HEAD"]);
  await git(primary, ["worktree", "add", "--detach", worktreeA, mainCommit]);
  await git(primary, ["worktree", "add", "--detach", worktreeB, mainCommit]);
  await writeScenarioFiles(worktreeA, "worktreeAValue");
  await writeScenarioFiles(worktreeB, "worktreeBValue");

  clearGitMemoryVersionContextCache();
  const [mainDetected, releaseDetected, worktreeADetected, worktreeBDetected, taskA, taskB] = await Promise.all([
    detectGitMemoryVersionContext({ workspaceDir: primary }),
    detectGitMemoryVersionContext({ workspaceDir: release }),
    detectGitMemoryVersionContext({ workspaceDir: worktreeA }),
    detectGitMemoryVersionContext({ workspaceDir: worktreeB }),
    detectGitMemoryVersionContext({ workspaceDir: primary, taskId: "parallel-alpha" }),
    detectGitMemoryVersionContext({ workspaceDir: primary, taskId: "parallel-beta" }),
  ]);
  if (!mainDetected || !releaseDetected || !worktreeADetected || !worktreeBDetected || !taskA || !taskB) {
    throw new Error("real Git version-context detection did not return every required scope");
  }
  const mainBranch: MemoryVersionContext = {
    ...mainDetected,
    worktreeId: undefined,
    taskId: undefined,
    scopeLevel: "branch",
  };
  const releaseBranch: MemoryVersionContext = {
    ...releaseDetected,
    worktreeId: undefined,
    taskId: undefined,
    scopeLevel: "branch",
  };
  const contexts = {
    mainBranch,
    releaseBranch,
    worktreeA: worktreeADetected,
    worktreeB: worktreeBDetected,
    taskA,
    taskB,
  };
  const repositoryIds = new Set(Object.values(contexts).map((context) => context.repositoryId));
  if (repositoryIds.size !== 1) throw new Error("fixture worktrees did not share one repository identity");
  if (worktreeADetected.worktreeId === worktreeBDetected.worktreeId) {
    throw new Error("fixture worktrees did not receive distinct worktree identities");
  }
  return { root, primary, release, worktreeA, worktreeB, mainCommit, releaseCommit, contexts, scenarios: SCENARIOS };
}

function readerMessages(question: LifecycleEvalQuestion, result: RecallResult | undefined): VersionAwareReaderMessage[] {
  const system = [
    [
      "You are a coding agent with access to TencentDB Agent Memory.",
      "Answer based ONLY on the provided memory context; never invent a state.",
      "For ordinary execution, use only ACTIVE SCOPE states with active_here=yes.",
      "For comparison, migration, regression, or history questions, preserve every VERSION STATE label and map values to the correct branch/worktree/task.",
      "HISTORICAL / SUPERSEDED and CURRENT / ACTIVE labels describe a linear old-current chain, not independent branches.",
      "If scoped evidence is absent or ambiguous, say that the current state cannot be determined.",
    ].join(" "),
    result?.appendSystemContext,
  ].filter(Boolean).join("\n\n");
  const user = [
    result?.prependContext,
    `Question date: ${question.questionDate}\nUser's question: ${question.query}\n\nAnswer concisely and include exact commands, paths, flags, ports, or values when present.`,
  ].filter(Boolean).join("\n\n");
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

function buildContextEntry(caseId: string, result: RecallResult | undefined, elapsedMs: number): VersionAwareContextEntry {
  const messages = readerMessages((activeQuestionById.get(caseId))!, result);
  const memories = result?.recalledL1Memories ?? [];
  return {
    hash: sha256(JSON.stringify(messages)),
    caseId,
    messages,
    prependContext: result?.prependContext ?? "",
    appendSystemContext: result?.appendSystemContext ?? "",
    injectedTokens: encoding.encode([result?.appendSystemContext, result?.prependContext].filter(Boolean).join("\n\n")).length,
    recalledMemoryIds: memories.flatMap((item) => item.id ? [item.id] : []),
    recalledMemories: memories,
    lifecycleMode: result?.lifecycleDecision?.mode ?? "none",
    versionScopeStatus: result?.lifecycleDecision?.versionScopeStatus,
    versionIntent: result?.lifecycleDecision?.versionIntent,
    versionSuppressedCandidates: result?.lifecycleDecision?.versionSuppressedCandidates ?? 0,
    versionLabeledStates: result?.lifecycleDecision?.versionLabeledStates ?? 0,
    elapsedMs,
  };
}

const activeQuestionById = new Map<string, LifecycleEvalQuestion>();

async function runRecall(params: {
  caseId: string;
  question: LifecycleEvalQuestion;
  arm: VersionAwareArm;
  store: VectorStore;
  pluginDataDir: string;
  current?: MemoryVersionContext;
  resultLimit: number;
}): Promise<VersionAwareContextEntry> {
  activeQuestionById.set(params.caseId, params.question);
  const lifecycle = VERSION_AWARE_CONTEXT_PROTOCOL.productionPath.lifecycle;
  const cfg = parseConfig({
    recall: {
      strategy: "keyword",
      scoreThreshold: 0,
      maxResults: params.resultLimit,
      maxCharsPerMemory: 0,
      maxTotalRecallChars: 0,
      timeoutMs: 5000,
      lifecycle: {
        enabled: true,
        feedbackEnabled: false,
        dualStateMode: params.arm === "old_current_dual" ? "query_aware" : "off",
        versionAwareMode: params.arm === "version_aware_multistate" ? "strict" : "off",
        autoDetectGit: false,
        versionCandidateMultiplier: VERSION_AWARE_CONTEXT_PROTOCOL.productionPath.versionCandidateMultiplier,
        maxVersionStates: VERSION_AWARE_CONTEXT_PROTOCOL.productionPath.maxVersionStates,
        minConfidence: lifecycle.minConfidence,
        maxHops: lifecycle.maxHops,
        maxExpansions: lifecycle.maxExpansions,
        timeoutMs: lifecycle.timeoutMs,
        maxEvents: lifecycle.maxEvents,
      },
    },
  });
  const started = performance.now();
  const result = await performAutoRecall({
    userText: params.question.query,
    actorId: USER_ID,
    sessionKey: SESSION_KEY,
    cfg,
    pluginDataDir: params.pluginDataDir,
    vectorStore: params.store,
    profileIsolation: { teamId: TEAM_ID, agentId: AGENT_ID },
    versionContext: params.arm === "version_aware_multistate" ? params.current : undefined,
    taskId: params.current?.taskId,
  });
  if (result?.error) throw new Error(`recall failed ${params.caseId}/${params.arm}: ${result.error.message}`);
  return buildContextEntry(params.caseId, result, performance.now() - started);
}

function criterion(id: string, question: string, type: "memory_presence" | "forgetting_absence" = "memory_presence") {
  return { id, question, expectedAnswer: "yes" as const, type };
}

function capabilityQuestion(
  scenario: ScenarioDefinition,
  slice: Exclude<VersionAwareSlice, "natural_safety">,
): LifecycleEvalQuestion {
  const id = `version:${scenario.id}:${slice}`;
  const common = {
    id,
    groupId: `version:${scenario.id}`,
    persona: scenario.id,
    period: "weekly" as const,
    task: slice,
    questionDate: "2026-08-31",
    currentSessionIds: [],
    obsoleteSessionIds: [],
    currentAtoms: [],
    obsoleteAtoms: [],
  };
  switch (slice) {
    case "branch_current":
      return {
        ...common,
        query: `In the current release branch, what is the ${scenario.facet} for project ${scenario.id}?`,
        evaluationQuestions: [
          criterion(`${id}:expected`, `Does the answer state that the active release-branch ${scenario.facet} is exactly ${scenario.releaseValue}?`),
          criterion(`${id}:no-cross-branch`, `Does the answer avoid presenting ${scenario.mainValue} as the active release-branch value?`, "forgetting_absence"),
        ],
        memoryPresenceQuestions: 1,
        forgettingAbsenceQuestions: 1,
      };
    case "worktree_current":
      return {
        ...common,
        query: `In this current detached worktree A, what is the ${scenario.facet} for project ${scenario.id}?`,
        evaluationQuestions: [
          criterion(`${id}:expected`, `Does the answer state that the active worktree-A ${scenario.facet} is exactly ${scenario.worktreeAValue}?`),
          criterion(`${id}:no-other-worktree`, `Does the answer avoid presenting ${scenario.worktreeBValue} as active in worktree A?`, "forgetting_absence"),
        ],
        memoryPresenceQuestions: 1,
        forgettingAbsenceQuestions: 1,
      };
    case "parallel_task_current":
      return {
        ...common,
        query: `For the current parallel task alpha in this worktree, what is the ${scenario.facet} for project ${scenario.id}?`,
        evaluationQuestions: [
          criterion(`${id}:expected`, `Does the answer state that task alpha uses exactly ${scenario.taskAValue} for ${scenario.facet}?`),
          criterion(`${id}:no-other-task`, `Does the answer avoid presenting task beta's value ${scenario.taskBValue} as active for task alpha?`, "forgetting_absence"),
        ],
        memoryPresenceQuestions: 1,
        forgettingAbsenceQuestions: 1,
      };
    case "branch_comparison":
      return {
        ...common,
        query: `Compare the old release branch with the new main branch for project ${scenario.id}. What is the ${scenario.facet} on each branch?`,
        evaluationQuestions: [
          criterion(`${id}:release`, `Does the answer map release to exactly ${scenario.releaseValue}?`),
          criterion(`${id}:main`, `Does the answer map main to exactly ${scenario.mainValue}?`),
        ],
        memoryPresenceQuestions: 2,
        forgettingAbsenceQuestions: 0,
      };
    case "migration":
      return {
        ...common,
        query: `We are migrating project ${scenario.id} from release to main. How must the ${scenario.facet} change?`,
        evaluationQuestions: [
          criterion(`${id}:mapping`, `Does the answer state a migration from ${scenario.releaseValue} on release to ${scenario.mainValue} on main?`),
        ],
        memoryPresenceQuestions: 1,
        forgettingAbsenceQuestions: 0,
      };
    case "regression":
      return {
        ...common,
        query: `A regression appeared from release to main in project ${scenario.id}. What changed in the ${scenario.facet} across those branches?`,
        evaluationQuestions: [
          criterion(`${id}:mapping`, `Does the answer correctly attribute ${scenario.releaseValue} to release and ${scenario.mainValue} to main?`),
        ],
        memoryPresenceQuestions: 1,
        forgettingAbsenceQuestions: 0,
      };
    case "missing_scope_abstention":
      return {
        ...common,
        query: `What is the current ${scenario.facet} for project ${scenario.id}?`,
        evaluationQuestions: [
          criterion(`${id}:abstain`, "Does the answer explicitly say that the current scoped value cannot be determined from the available memory context?"),
          criterion(`${id}:no-guess`, `Does the answer avoid selecting any of ${scenario.mainValue}, ${scenario.releaseValue}, ${scenario.worktreeAValue}, ${scenario.worktreeBValue}, ${scenario.taskAValue}, or ${scenario.taskBValue} as the current value?`, "forgetting_absence"),
        ],
        memoryPresenceQuestions: 1,
        forgettingAbsenceQuestions: 1,
      };
  }
}

function scopedContent(scenario: ScenarioDefinition, label: string, value: string): string {
  return `Project ${scenario.id} ${scenario.facet}: ${value}. State owner: ${label}.`;
}

async function writeScopedScenario(
  store: VectorStore,
  storage: StorageAdapter,
  baseDir: string,
  scenario: ScenarioDefinition,
  contexts: FixtureContexts,
): Promise<Record<string, string>> {
  const states: Array<{ suffix: string; label: string; value: string; context: MemoryVersionContext }> = [
    { suffix: "main", label: "main branch", value: scenario.mainValue, context: contexts.mainBranch },
    { suffix: "release", label: "release branch", value: scenario.releaseValue, context: contexts.releaseBranch },
    { suffix: "worktree-a", label: "detached worktree A", value: scenario.worktreeAValue, context: contexts.worktreeA },
    { suffix: "worktree-b", label: "detached worktree B", value: scenario.worktreeBValue, context: contexts.worktreeB },
    { suffix: "task-alpha", label: "parallel task alpha", value: scenario.taskAValue, context: contexts.taskA },
    { suffix: "task-beta", label: "parallel task beta", value: scenario.taskBValue, context: contexts.taskB },
  ];
  const ids: Record<string, string> = {};
  // Deliberately write the globally newer-looking sibling first. Baseline
  // ranking is not hand-injected; FTS5 decides among the real stored rows.
  for (const state of states) {
    const id = `version-${scenario.id}-${state.suffix}`;
    const written = await writeMemory({
      memory: {
        content: scopedContent(scenario, state.label, state.value),
        type: "work_fact",
        priority: 80,
        source_message_ids: [`fixture:${scenario.id}:${state.suffix}`],
        metadata: {},
        scene_name: "version-aware-eval",
      },
      decision: { record_id: id, action: "store", target_ids: [] },
      baseDir,
      storage,
      sessionKey: `session-${scenario.id}-${state.suffix}`,
      sessionId: `session-${scenario.id}-${state.suffix}`,
      taskId: state.context.taskId,
      teamId: TEAM_ID,
      userId: USER_ID,
      agentId: AGENT_ID,
      vectorStore: store,
      versionContext: state.context,
    });
    if (!written) throw new Error(`writeMemory returned null for ${id}`);
    ids[state.suffix] = id;
  }
  return ids;
}

async function appendNaiveLinearEdges(baseDir: string, ids: Record<string, string>): Promise<void> {
  const pairs = [
    [ids.release, ids.main],
    [ids["worktree-a"], ids["worktree-b"]],
    [ids["task-alpha"], ids["task-beta"]],
  ];
  for (let index = 0; index < pairs.length; index += 1) {
    await appendLifecycleFeedbackEvent({
      baseDir,
      event: {
        schemaVersion: 1,
        eventId: `naive-linear-${ids.main}-${index}`,
        kind: "update",
        occurredAtMs: Date.parse("2026-08-31T00:00:00Z") + index,
        confidence: 0.95,
        source: "test",
        predecessorMemoryIds: [pairs[index][0]],
        successorMemoryIds: [pairs[index][1]],
        scope: { teamId: TEAM_ID, userId: USER_ID, agentId: AGENT_ID },
      },
    });
  }
}

function currentForSlice(slice: Exclude<VersionAwareSlice, "natural_safety">, contexts: FixtureContexts): MemoryVersionContext | undefined {
  switch (slice) {
    case "branch_current": return contexts.releaseBranch;
    case "worktree_current": return contexts.worktreeA;
    case "parallel_task_current": return contexts.taskA;
    case "branch_comparison":
    case "migration":
    case "regression": return contexts.mainBranch;
    case "missing_scope_abstention": return undefined;
  }
}

function expectedIdsForSlice(
  slice: Exclude<VersionAwareSlice, "natural_safety">,
  ids: Record<string, string>,
): string[] {
  switch (slice) {
    case "branch_current": return [ids.release];
    case "worktree_current": return [ids["worktree-a"]];
    case "parallel_task_current": return [ids["task-alpha"]];
    case "branch_comparison":
    case "migration":
    case "regression": return [ids.main, ids.release].sort();
    case "missing_scope_abstention": return [];
  }
}

function extractActivityDate(prependContext: string, content: string): string | undefined {
  const line = prependContext.split("\n").find((item) => item.includes(content));
  return line?.match(/活动时间:\s*(\d{4}-\d{2}-\d{2})/)?.[1];
}

async function writeNaturalCandidates(params: {
  store: VectorStore;
  storage: StorageAdapter;
  baseDir: string;
  prior: PriorContext;
  persona: string;
}): Promise<void> {
  for (let index = 0; index < params.prior.recalledMemories.length; index += 1) {
    const item = params.prior.recalledMemories[index];
    const id = item.id ?? `natural-${sha256(`${params.prior.caseId}:${index}`).slice(0, 16)}`;
    const activityDate = extractActivityDate(params.prior.prependContext, item.content);
    const type: MemoryType = activityDate ? "episodic" : "work_fact";
    const written = await writeMemory({
      memory: {
        content: item.content,
        type,
        priority: 80,
        source_message_ids: [`memora:${id}`],
        metadata: activityDate ? { activity_start_time: activityDate, activity_end_time: activityDate } : {},
        scene_name: "version-aware-natural-safety",
      },
      decision: { record_id: id, action: "store", target_ids: [] },
      baseDir: params.baseDir,
      storage: params.storage,
      sessionKey: `memora-${params.persona}`,
      sessionId: `memora-${params.persona}`,
      teamId: TEAM_ID,
      userId: USER_ID,
      agentId: AGENT_ID,
      vectorStore: params.store,
    });
    if (!written) throw new Error(`natural writeMemory returned null for ${id}`);
  }
}

function addContext(contexts: Map<string, VersionAwareContextEntry>, entry: VersionAwareContextEntry): string {
  const existing = contexts.get(entry.hash);
  if (existing && existing.caseId !== entry.caseId) throw new Error(`cross-case prompt collision ${entry.hash}`);
  if (!existing) contexts.set(entry.hash, entry);
  return entry.hash;
}

function selectNaturalCases(prior: PriorManifest): PriorCase[] {
  const selected: PriorCase[] = [];
  const natural = prior.cases.filter((item) => item.panel === "natural_safety");
  for (const persona of [...new Set(natural.map((item) => item.persona))].sort()) {
    selected.push(...natural.filter((item) => item.persona === persona)
      .sort((left, right) => left.caseId.localeCompare(right.caseId, "en"))
      .slice(0, 4));
  }
  return selected;
}

export async function buildVersionAwareContexts(options: VersionAwareContextOptions): Promise<Record<string, any>> {
  const [priorText, loaded, protocolText, revision] = await Promise.all([
    readFile(options.priorContextManifest, "utf8"),
    loadMemora(options.dataRoot, !options.skipHashVerification),
    readFile(new URL("../protocol.version-aware-context.v1.json", import.meta.url), "utf8"),
    sourceRevision(),
  ]);
  if (sha256(priorText) !== VERSION_AWARE_CONTEXT_PROTOCOL.inputs.priorNaturalContextManifestSha256) {
    throw new Error("prior production context manifest hash mismatch");
  }
  if (loaded.description.revision !== VERSION_AWARE_CONTEXT_PROTOCOL.inputs.memora.revision) {
    throw new Error(`Memora revision mismatch: ${loaded.description.revision}`);
  }
  const prior = JSON.parse(priorText) as PriorManifest;
  const priorContexts = new Map(prior.contexts.map((item) => [item.hash, item]));
  const questions = new Map(loaded.groups.flatMap((group) => group.questions).map((item) => [item.id, item]));
  const fixture = await buildGitFixture(options.fixtureRoot);
  const contexts = new Map<string, VersionAwareContextEntry>();
  const cases: VersionAwareManifestCase[] = [];
  const latencies: number[] = [];
  let sqliteDatabases = 0;
  let writeMemoryCalls = 0;
  let recallCalls = 0;
  let lifecycleFallbacks = 0;
  let versionCurrentMismatches = 0;
  let comparisonSetMismatches = 0;
  let missingScopeMismatches = 0;
  let naturalPromptMismatches = 0;

  const capabilitySlices = VERSION_AWARE_CONTEXT_PROTOCOL.selection.capabilitySlices
    .filter((slice): slice is Exclude<VersionAwareSlice, "natural_safety"> => slice !== "natural_safety");
  for (const scenario of fixture.scenarios) {
    const temp = await mkdtemp(path.join(os.tmpdir(), `version-aware-${scenario.id}-`));
    const store = new VectorStore(path.join(temp, "vectors.db"), 0);
    store.init();
    sqliteDatabases += 1;
    const storage = new StorageAdapter(new LocalStorageBackend(temp));
    const dualDir = path.join(temp, "old-current-dual");
    await mkdir(dualDir, { recursive: true });
    try {
      const ids = await writeScopedScenario(store, storage, temp, scenario, fixture.contexts);
      writeMemoryCalls += 6;
      await appendNaiveLinearEdges(dualDir, ids);
      for (const slice of capabilitySlices) {
        const question = capabilityQuestion(scenario, slice);
        activeQuestionById.set(question.id, question);
        const armHashes = {} as Record<VersionAwareArm, string>;
        for (const arm of VERSION_AWARE_CONTEXT_PROTOCOL.arms) {
          const pluginDataDir = arm === "old_current_dual" ? dualDir : path.join(temp, arm);
          await mkdir(pluginDataDir, { recursive: true });
          const entry = await runRecall({
            caseId: question.id,
            question,
            arm,
            store,
            pluginDataDir,
            current: currentForSlice(slice, fixture.contexts),
            resultLimit: VERSION_AWARE_CONTEXT_PROTOCOL.productionPath.resultLimit,
          });
          recallCalls += 1;
          latencies.push(entry.elapsedMs);
          if (entry.lifecycleMode === "fallback") lifecycleFallbacks += 1;
          armHashes[arm] = addContext(contexts, entry);
        }
        const candidateEntry = contexts.get(armHashes.version_aware_multistate)!;
        const expectedIds = expectedIdsForSlice(slice, ids);
        const observedIds = [...candidateEntry.recalledMemoryIds].sort();
        if (slice === "branch_comparison" || slice === "migration" || slice === "regression") {
          if (observedIds.join("\0") !== expectedIds.join("\0")) comparisonSetMismatches += 1;
        } else if (slice === "missing_scope_abstention") {
          if (observedIds.length !== 0 || candidateEntry.prependContext.length !== 0) missingScopeMismatches += 1;
        } else if (observedIds.join("\0") !== expectedIds.join("\0")) {
          versionCurrentMismatches += 1;
        }
        cases.push({
          caseId: question.id,
          panel: "version_capability",
          slice,
          groupId: question.groupId,
          persona: question.persona,
          task: question.task,
          question,
          expectedVersionAwareMemoryIds: expectedIds,
          arms: armHashes,
        });
      }
    } finally {
      store.close();
      await rm(temp, { recursive: true, force: true });
    }
  }

  const selectedNatural = selectNaturalCases(prior);
  for (const selected of selectedNatural) {
    const question = questions.get(selected.caseId);
    const priorHash = selected.arms.global_latest ?? selected.arms.current_only ?? Object.values(selected.arms)[0];
    const priorContext = priorContexts.get(priorHash);
    if (!question || !priorContext) throw new Error(`missing selected natural input ${selected.caseId}`);
    activeQuestionById.set(question.id, question);
    const temp = await mkdtemp(path.join(os.tmpdir(), "version-aware-natural-"));
    const store = new VectorStore(path.join(temp, "vectors.db"), 0);
    store.init();
    sqliteDatabases += 1;
    const storage = new StorageAdapter(new LocalStorageBackend(temp));
    try {
      await writeNaturalCandidates({ store, storage, baseDir: temp, prior: priorContext, persona: selected.persona });
      writeMemoryCalls += priorContext.recalledMemories.length;
      const armHashes = {} as Record<VersionAwareArm, string>;
      for (const arm of VERSION_AWARE_CONTEXT_PROTOCOL.arms) {
        const pluginDataDir = path.join(temp, arm);
        await mkdir(pluginDataDir, { recursive: true });
        const entry = await runRecall({
          caseId: question.id,
          question,
          arm,
          store,
          pluginDataDir,
          current: fixture.contexts.mainBranch,
          resultLimit: Math.max(1, priorContext.recalledMemories.length),
        });
        recallCalls += 1;
        latencies.push(entry.elapsedMs);
        if (entry.lifecycleMode === "fallback") lifecycleFallbacks += 1;
        armHashes[arm] = addContext(contexts, entry);
      }
      if (new Set(Object.values(armHashes)).size !== 1) naturalPromptMismatches += 1;
      cases.push({
        caseId: question.id,
        panel: "natural_safety",
        slice: "natural_safety",
        groupId: question.groupId,
        persona: question.persona,
        task: question.task,
        question,
        expectedVersionAwareMemoryIds: contexts.get(armHashes.version_aware_multistate)!.recalledMemoryIds,
        arms: armHashes,
      });
    } finally {
      store.close();
      await rm(temp, { recursive: true, force: true });
    }
  }

  const expected = VERSION_AWARE_CONTEXT_PROTOCOL.selection;
  const countMismatch = cases.length !== expected.totalCases
    || cases.filter((item) => item.panel === "natural_safety").length !== expected.naturalCases
    || cases.filter((item) => item.panel === "version_capability").length !== expected.capabilityCases;
  const validation = {
    realGit: true,
    sharedRepositoryIdentity: new Set(Object.values(fixture.contexts).map((item) => item.repositoryId)).size === 1,
    distinctWorktreeIdentity: fixture.contexts.worktreeA.worktreeId !== fixture.contexts.worktreeB.worktreeId,
    realSQLite: sqliteDatabases > 0,
    countMismatch,
    lifecycleFallbacks,
    versionCurrentMismatches,
    comparisonSetMismatches,
    missingScopeMismatches,
    naturalPromptMismatches,
    passed: !countMismatch
      && lifecycleFallbacks === 0
      && versionCurrentMismatches === 0
      && comparisonSetMismatches === 0
      && missingScopeMismatches === 0
      && naturalPromptMismatches === 0,
  };
  const contextEntries = [...contexts.values()].sort((left, right) =>
    left.caseId.localeCompare(right.caseId, "en") || left.hash.localeCompare(right.hash, "en"));
  const manifest = {
    protocolVersion: VERSION_AWARE_CONTEXT_PROTOCOL.protocolVersion,
    generatedAt: new Date().toISOString(),
    preScoreSourceRevision: revision,
    protocolSha256: sha256(protocolText),
    dataset: loaded.description,
    priorNaturalContextManifestSha256: sha256(priorText),
    fixture: {
      mainCommit: fixture.mainCommit,
      releaseCommit: fixture.releaseCommit,
      repositoryId: fixture.contexts.mainBranch.repositoryId,
      branches: [fixture.contexts.mainBranch.branch, fixture.contexts.releaseBranch.branch],
      worktreeIds: [fixture.contexts.worktreeA.worktreeId, fixture.contexts.worktreeB.worktreeId],
      taskIds: [fixture.contexts.taskA.taskId, fixture.contexts.taskB.taskId],
      rawPathsPersisted: false,
      scenarioCount: fixture.scenarios.length,
      workingTreeStatesGroundedInFiles: true,
    },
    productionPath: VERSION_AWARE_CONTEXT_PROTOCOL.productionPath,
    arms: VERSION_AWARE_CONTEXT_PROTOCOL.arms,
    selection: {
      cases: cases.length,
      naturalCases: cases.filter((item) => item.panel === "natural_safety").length,
      capabilityCases: cases.filter((item) => item.panel === "version_capability").length,
      scenarios: fixture.scenarios.length,
      bySlice: Object.fromEntries([...new Set(cases.map((item) => item.slice))].sort()
        .map((slice) => [slice, cases.filter((item) => item.slice === slice).length])),
      personas: new Set(cases.map((item) => item.persona)).size,
    },
    cases,
    contexts: contextEntries,
    deduplication: {
      caseArmContexts: cases.length * VERSION_AWARE_CONTEXT_PROTOCOL.arms.length,
      uniquePromptsPerReader: contextEntries.length,
      exactPromptReuseOnly: true,
    },
    execution: {
      gitRepositories: 1,
      sqliteDatabases,
      writeMemoryCalls,
      performAutoRecallCalls: recallCalls,
      meanRecallMs: mean(latencies),
      p95RecallMs: percentile(latencies, 0.95),
      maxRecallMs: Math.max(...latencies),
      readerCalls: 0,
      judgeCalls: 0,
    },
    validation,
    status: validation.passed ? "context_ready" : "failed",
    claimBoundary: VERSION_AWARE_CONTEXT_PROTOCOL.claimBoundary,
  };
  const output = `${JSON.stringify(manifest, null, 2)}\n`;
  await mkdir(options.outputDir, { recursive: true });
  await writeFile(path.join(options.outputDir, "context-manifest.json"), output, "utf8");
  await writeFile(path.join(options.outputDir, "context-summary.json"), `${JSON.stringify({
    protocolVersion: manifest.protocolVersion,
    status: manifest.status,
    preScoreSourceRevision: manifest.preScoreSourceRevision,
    protocolSha256: manifest.protocolSha256,
    contextManifestSha256: sha256(output),
    dataset: manifest.dataset,
    fixture: manifest.fixture,
    selection: manifest.selection,
    deduplication: manifest.deduplication,
    execution: manifest.execution,
    validation: manifest.validation,
    claimBoundary: manifest.claimBoundary,
  }, null, 2)}\n`, "utf8");
  return manifest;
}
