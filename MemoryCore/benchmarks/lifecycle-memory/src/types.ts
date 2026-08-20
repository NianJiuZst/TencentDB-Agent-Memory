export type MemoraPeriod = "weekly" | "monthly" | "quarterly";

export interface MemoraConversationTurn {
  turn: number;
  speaker: string;
  message: string;
  share_memory: boolean;
}

export interface MemoraSession {
  session_id: number;
  session_type: string;
  operation?: string;
  operation_details?: Record<string, unknown>;
  date: string;
  persona: string;
  conversation: MemoraConversationTurn[];
}

export interface MemoraEvaluationQuestion {
  question_id: string;
  question: string;
  question_date: string;
  memory_evidence?: unknown;
  forgetting_evidence?: unknown;
  evaluation?: {
    evaluation_questions?: Array<{
      evaluation_question_id: string;
      evaluation_question: string;
      expected_answer: "yes" | "no";
      evaluation_type: "memory_presence" | "forgetting_absence";
    }>;
    total_evaluation_questions?: number;
    memory_presence_questions?: number;
    forgetting_absence_questions?: number;
  };
}

export interface EvaluationCriterion {
  id: string;
  question: string;
  expectedAnswer: "yes" | "no";
  type: "memory_presence" | "forgetting_absence";
}

export interface MemoryUnit {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  timestampMs: number;
}

export interface EvidenceAtom {
  id: string;
  value: string;
  sourceSessionIds: string[];
}

export interface LifecycleEvalQuestion {
  id: string;
  groupId: string;
  persona: string;
  period: MemoraPeriod;
  task: string;
  query: string;
  questionDate: string;
  currentSessionIds: string[];
  obsoleteSessionIds: string[];
  currentAtoms: EvidenceAtom[];
  obsoleteAtoms: EvidenceAtom[];
  evaluationQuestions: EvaluationCriterion[];
  memoryPresenceQuestions: number;
  forgettingAbsenceQuestions: number;
}

export interface LifecycleEvalGroup {
  id: string;
  persona: string;
  period: MemoraPeriod;
  units: MemoryUnit[];
  questions: LifecycleEvalQuestion[];
}

export interface DatasetDescription {
  name: string;
  revision: string;
  dataManifestSha256: string;
  groups: number;
  personas: number;
  questions: number;
  sessions: number;
  memoryUnits: number;
  operationCounts: Record<string, number>;
}

export interface RetrievedUnit extends MemoryUnit {
  score: number;
  tokenCount: number;
}

export type HeadroomArm = "base" | "oracle_query" | "oracle_write" | "oracle_full";

export interface CaseMetrics {
  currentSessionRecall: number;
  currentAny: number;
  currentAll: number;
  forgettingAbsence: number;
  obsoleteAny: number;
  obsoleteSessionRate: number;
  staleInjectionRate: number;
  evidenceFamaProxy: number;
  injectedItems: number;
  injectedTokens: number;
}

export interface CaseResult {
  caseId: string;
  groupId: string;
  persona: string;
  period: MemoraPeriod;
  task: string;
  forgettingBearing: boolean;
  arm: HeadroomArm;
  candidateIds: string[];
  sourceSessionIds: string[];
  queryLatencyMs: number;
  metrics: CaseMetrics;
}

export interface AggregateMetrics {
  cases: number;
  currentSessionRecall: number;
  currentAnyRate: number;
  currentAllRate: number;
  forgettingAbsence: number;
  obsoleteAnyRate: number;
  obsoleteSessionRate: number;
  staleInjectionRate: number;
  evidenceFamaProxy: number;
  meanInjectedItems: number;
  meanInjectedTokens: number;
  queryLatencyP50Ms: number;
  queryLatencyP95Ms: number;
}

export interface BootstrapInterval {
  mean: number;
  lower: number;
  upper: number;
  clusters: number;
}
