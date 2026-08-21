/**
 * Dataset-neutral boundary for long-horizon interactive task evaluations.
 *
 * Public adapters translate their native schemas into these records. Retrieval,
 * policy selection, metrics, and reporting must depend on this boundary rather
 * than on a benchmark's JSON field names.
 */
export interface LongTaskQuestion {
  id: string;
  domain: string;
  environment: string;
  memoryAbility: string;
  prompt: string;
  referenceAnswer: string;
  evaluator: string;
  imagePath: string | null;
  trajectoryIds: string[];
}

export interface LongTaskState {
  id: string;
  trajectoryId: string;
  index: number;
  sourceStep: number | null;
  url: string;
  observation: string;
  thought: string | null;
  /**
   * Action that transformed the previous state into this state. Adapters must
   * normalize source-specific action placement to this destination-state form.
   */
  transitionAction: string | null;
  screenshotPath: string | null;
}

export interface LongTaskTrajectory {
  id: string;
  domain: string;
  environment: string;
  goal: string;
  outcome: string;
  startUrl: string;
  states: LongTaskState[];
}

export interface LongTaskDatasetDescription {
  name: string;
  revision: string;
  tier: string;
  manifestSha256: string;
  questions: number;
  textOnlyQuestions: number;
  questionTypes: Record<string, number>;
  trajectoryRows: number;
  selectedTrajectories: number;
  sharedHaystacks: number;
  states: number;
  observationCharacters: number;
  thoughtCharacters: number;
  actionCharacters: number;
  emptyObservationStates: number;
  initialStatesWithAction: number;
  trajectoryDomains: Record<string, number>;
  trajectoryEnvironments: Record<string, number>;
  outcomes: Record<string, number>;
  sourceSha256: Record<string, string>;
}

export interface LongTaskDatasetAdapter {
  readonly name: string;
  readonly revision: string;
  readonly tier: string;
  describe(): Promise<LongTaskDatasetDescription>;
  loadQuestions(): Promise<LongTaskQuestion[]>;
  loadTrajectories(ids: readonly string[]): Promise<LongTaskTrajectory[]>;
}
