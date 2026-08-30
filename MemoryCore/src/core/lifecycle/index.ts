export { applyLifecyclePolicy, DEFAULT_LIFECYCLE_LIMITS, LifecycleLedger } from "./ledger.js";
export {
  applyLifecycleEvidenceShield,
  DEFAULT_EVIDENCE_SHIELD_LIMITS,
  LifecycleEvidenceShield,
} from "./evidence-shield.js";
export {
  applyLifecycleDeleteVacancy,
  DEFAULT_DELETE_VACANCY_LIMITS,
  LifecycleDeleteVacancy,
} from "./delete-vacancy.js";
export { applyLifecycleValidStatePacking } from "./valid-state-packer.js";
export {
  applyLifecycleDominanceGuard,
  applyLifecycleTargetState,
  DEFAULT_TARGET_STATE_LIMITS,
  LifecycleTargetState,
} from "./target-state.js";
export { optimizeLifecyclePolicy } from "./optimizer.js";
export { promoteLifecyclePolicy } from "./promotion.js";
export { applyPersistedLifecycle } from "./production-runtime.js";
export {
  classifyLifecycleTemporalIntent,
  lifecycleIntentAllowsDualState,
} from "./temporal-intent.js";
export { detectGitMemoryVersionContext, clearGitMemoryVersionContextCache } from "./git-context.js";
export { loadSessionVersionContext, persistSessionVersionContext } from "./version-context-store.js";
export {
  classifyVersionQueryIntent,
  formatMemoryVersionLabel,
  memoryVersionContextApplies,
  memoryVersionScopeKey,
  memoryVersionSpecificity,
  memoryVersionWriteDomainsEqual,
  normalizeMemoryVersionContext,
  parseMemoryVersionContextFromMetadata,
  selectVersionAwareCandidates,
  versionIntentAllowsMultipleStates,
  withMemoryVersionContext,
  MEMORY_VERSION_CONTEXT_METADATA_KEY,
} from "./version-scope.js";
export {
  appendLifecycleFeedbackEvent,
  lifecycleFeedbackMatchesScope,
  loadLifecycleFeedbackEvents,
  parseLifecycleFeedbackEvent,
} from "./feedback-store.js";
export type * from "./types.js";
export type * from "./feedback-store.js";
export type * from "./production-runtime.js";
export type * from "./temporal-intent.js";
export type * from "./version-scope.js";
export type {
  LifecycleEvidenceShieldDecision,
  LifecycleEvidenceShieldLimits,
  LifecycleEvidenceShieldPolicy,
  LifecycleEvidenceShieldResolution,
  LifecycleEvidenceShieldResult,
  LifecycleEvidenceShieldSource,
} from "./evidence-shield.js";
export type {
  LifecycleDeleteVacancyDecision,
  LifecycleDeleteVacancyLimits,
  LifecycleDeleteVacancyPolicy,
  LifecycleDeleteVacancyResolution,
  LifecycleDeleteVacancyResult,
  LifecycleDeleteVacancySource,
} from "./delete-vacancy.js";
export type {
  LifecycleValidStatePackingDecision,
  LifecycleValidStatePackingPolicy,
  LifecycleValidStatePackingResult,
} from "./valid-state-packer.js";
export type {
  LifecycleDominanceDecision,
  LifecycleDominanceResult,
  LifecycleTargetStateClassification,
  LifecycleTargetStateDecision,
  LifecycleTargetStateKind,
  LifecycleTargetStateInspector,
  LifecycleTargetStateLimits,
  LifecycleTargetStateOperation,
  LifecycleTargetStatePolicy,
  LifecycleTargetStateResolution,
  LifecycleTargetStateResult,
  LifecycleTargetStateSource,
  LifecycleTargetStateValidity,
} from "./target-state.js";
