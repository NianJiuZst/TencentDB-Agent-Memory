export type LifecycleTemporalQueryIntent =
  | "current_state"
  | "historical_state"
  | "state_change"
  | "historical_aggregate";

const CHANGE_PATTERNS = [
  /\bhow (?:did|has|have).+chang(?:e|ed)\b/i,
  /\bwhat changed\b/i,
  /\bfrom .+ to\b/i,
  /\bcompare (?:the )?(?:old|previous|former).+(?:new|current)\b/i,
  /(?:怎么|如何|发生了什么)变(?:化|更)/,
  /从.+(?:变成|改成|更新为).+/,
];

const HISTORICAL_PATTERNS = [
  /\bprevious(?:ly)?\b/i,
  /\bformer(?:ly)?\b/i,
  /\bbefore .+ chang(?:e|ed)\b/i,
  /\bwhat (?:did|was|were).+used to\b/i,
  /\bat that time\b/i,
  /(?:之前|以前|曾经|原来|历史上)/,
];

const AGGREGATE_PATTERNS = [
  /\btotal\b/i,
  /\bhow many (?:days|weeks|months)\b/i,
  /\bhow much (?:have )?i spent\b/i,
  /\bwhich (?:week|month)\b/i,
  /\bmost steps\b/i,
  /\bmeet my .+ (?:budget|goal)\b/i,
  /(?:总共|合计|总计|哪个月|哪一周|累计)/,
];

/** Query-text-only gate. It never reads task labels, gold evidence or model output. */
export function classifyLifecycleTemporalIntent(query: string): LifecycleTemporalQueryIntent {
  if (CHANGE_PATTERNS.some((pattern) => pattern.test(query))) return "state_change";
  if (HISTORICAL_PATTERNS.some((pattern) => pattern.test(query))) return "historical_state";
  if (AGGREGATE_PATTERNS.some((pattern) => pattern.test(query))) return "historical_aggregate";
  return "current_state";
}

export function lifecycleIntentAllowsDualState(intent: LifecycleTemporalQueryIntent): boolean {
  return intent === "historical_state" || intent === "state_change";
}
