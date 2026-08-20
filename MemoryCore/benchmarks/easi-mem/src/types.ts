import type {
  QueryFeatures,
  RecallCandidate,
  RecallDecisionLog,
  RecallProfile,
  RouterNode,
} from "../../../src/core/adaptive-recall/index.js";

export interface EvalTurn {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  timestampMs: number;
  isGoldEvidence: boolean;
}

export interface EvalCase {
  id: string;
  /** Dependency cluster for uncertainty estimates (for example, one conversation). */
  groupId: string;
  query: string;
  answer: unknown;
  questionDate: string;
  category: string;
  abstention: boolean;
  turns: EvalTurn[];
  goldTurnIds: string[];
  goldSessionIds: string[];
}

export interface DatasetDescription {
  name: string;
  version: string;
  source: string;
  sha256: string;
  totalCases: number;
}

export interface ConversationDatasetAdapter {
  load(path: string): Promise<{ description: DatasetDescription; cases: EvalCase[] }>;
}

export interface BackendSearchResult {
  candidates: RecallCandidate[];
  indexedItems: number;
  indexLatencyMs: number;
  queryLatencyMs: number;
  queryLatencyByLimit: Record<string, number>;
  strategy: string;
}

export interface MemoryBackendAdapter {
  readonly name: string;
  indexAndSearch(evalCase: EvalCase, candidateLimits: number[]): Promise<BackendSearchResult>;
}

export type SplitName = "train" | "dev" | "test" | "abstention";

export interface CaseMetrics {
  recallAnySession: number;
  recallAllSessions: number;
  macroSessionRecall: number;
  recallAnyTurn: number;
  recallAllTurns: number;
  macroTurnRecall: number;
  ndcgSessions: number;
  injectedItems: number;
  injectedTokens: number;
  alignedTokens: number;
  alignedTokenRate: number;
}

export interface ArmCaseResult {
  caseId: string;
  category: string;
  split: SplitName;
  profile: string;
  candidateIds: string[];
  sourceSessionIds: string[];
  queryLatencyMs: number;
  metrics: CaseMetrics;
}

export interface CachedCaseResult {
  caseId: string;
  groupId: string;
  category: string;
  split: SplitName;
  query: string;
  documentCount: number;
  features: QueryFeatures;
  goldTurnIds: string[];
  goldSessionIds: string[];
  candidates: RecallCandidate[];
  indexLatencyMs: number;
  queryLatencyMs: number;
  queryLatencyByLimit: Record<string, number>;
  retrievalStrategy: string;
}

export interface AggregateMetrics {
  cases: number;
  recallAnySession: number;
  recallAllSessions: number;
  macroSessionRecall: number;
  recallAnyTurn: number;
  recallAllTurns: number;
  macroTurnRecall: number;
  ndcgSessions: number;
  meanInjectedItems: number;
  meanInjectedTokens: number;
  meanAlignedTokenRate: number;
  queryLatencyP50Ms: number;
  queryLatencyP95Ms: number;
}

export interface TrainedRouter {
  router: RouterNode;
  maxDepth: number;
  minLeaf: number;
  minConfidence: number;
  fallbackProfile: string;
  trainAccuracy: number;
}

export interface AdaptiveCaseResult extends ArmCaseResult {
  selectedProfile: string;
  decision: RecallDecisionLog;
}

export interface ExperimentProtocol {
  protocolVersion: string;
  seed: number;
  split: { train: number; dev: number; test: number };
  maxCandidates: number;
  bootstrapSamples: number;
  baselineProfile: RecallProfile;
  profiles: RecallProfile[];
  routerGrid: Array<{ maxDepth: number; minLeaf: number; minConfidence: number }>;
  promotion: {
    maxMacroRecallRegression: number;
    minTokenReduction: number;
    minUtilityCiLowerBound: number;
    tokenPenalty: number;
  };
}
