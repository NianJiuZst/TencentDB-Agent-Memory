export type LifecycleQueryIntent = "historical_aggregate" | "current_state";

const HISTORICAL_AGGREGATE_PATTERNS = [
  /\btotal\b/i,
  /\bhow many months\b/i,
  /\bhow much (?:have )?i spent\b/i,
  /\bwhich (?:week|month)\b/i,
  /\bmost steps\b/i,
  /\boverspend\b/i,
  /\bmeet my .+ budget\b/i,
  /\bam i meeting my .+ (?:budget|goal)\b/i,
];

/**
 * Memora-specific, query-text-only intent adapter. Internal programming data
 * should replace this classifier while keeping the contextual controller.
 */
export function classifyLifecycleQueryIntent(query: string): LifecycleQueryIntent {
  return HISTORICAL_AGGREGATE_PATTERNS.some((pattern) => pattern.test(query))
    ? "historical_aggregate"
    : "current_state";
}
