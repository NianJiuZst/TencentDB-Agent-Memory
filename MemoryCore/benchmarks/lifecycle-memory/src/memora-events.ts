import type { LifecycleEvent } from "../../../src/core/lifecycle/index.js";
import type { MemoraSession, MemoryUnit } from "./types.js";

const IGNORED_FIELD = /^(?:created_at|updated_at|generation_method|pool_status|status|action|field|type|category|subcategory|session_count|total_sessions_before_completion)$/i;

function scalar(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length >= 2 ? trimmed : null;
}

function valuesFrom(node: unknown, keyHint = "", output: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const entry of node) valuesFrom(entry, keyHint, output);
    return output;
  }
  if (!node || typeof node !== "object") {
    const value = scalar(node);
    if (value && !IGNORED_FIELD.test(keyHint)) output.push(value);
    return output;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    valuesFrom(value, key, output);
  }
  return output;
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function containsValue(content: string, value: string): boolean {
  const expected = normalized(value);
  return expected.length >= 2 && normalized(content).includes(expected);
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = normalized(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function objectEntries(node: unknown, prefix = "", output = new Map<string, string>()): Map<string, string> {
  if (Array.isArray(node)) {
    node.forEach((entry, index) => objectEntries(entry, `${prefix}[${index}]`, output));
    return output;
  }
  if (!node || typeof node !== "object") {
    const value = scalar(node);
    if (value && !IGNORED_FIELD.test(prefix.split(".").at(-1) ?? "")) output.set(prefix, value);
    return output;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    objectEntries(value, prefix ? `${prefix}.${key}` : key, output);
  }
  return output;
}

function changedOldValues(previous: unknown, current: unknown): string[] {
  const before = objectEntries(previous);
  const after = objectEntries(current);
  const changed: string[] = [];
  for (const [key, value] of before) {
    if (after.get(key) !== value) changed.push(value);
  }
  return unique(changed);
}

function activityKey(details: Record<string, unknown>): string | null {
  const item = details.item;
  if (typeof item === "string" || typeof item === "number") return `activity:${String(item)}`;
  if (!item || typeof item !== "object") return null;
  const record = item as Record<string, unknown>;
  const identity = record.description ?? record.event_name ?? record.title ?? record.name;
  return identity ? `activity:${String(details.category ?? "item")}:${String(identity)}` : null;
}

function eventSuccessors(session: MemoraSession, units: MemoryUnit[], obsoleteValues: string[]): string[] {
  const sessionUnits = units.filter((unit) => unit.sessionId === String(session.session_id));
  const matching = sessionUnits.filter((unit) => obsoleteValues.some((value) => containsValue(unit.content, value)));
  return (matching.length ? matching : sessionUnits).map((unit) => unit.id);
}

export interface MemoraLifecycleExtraction {
  events: LifecycleEvent[];
  sourceCounts: Record<string, number>;
}

export function extractMemoraLifecycleEvents(
  sessions: MemoraSession[],
  units: MemoryUnit[],
): MemoraLifecycleExtraction {
  const events: LifecycleEvent[] = [];
  const sourceCounts: Record<string, number> = {};
  const activityState = new Map<string, unknown>();

  const addEvent = (
    session: MemoraSession,
    kind: "update" | "delete",
    values: string[],
    confidence: number,
    source: string,
  ) => {
    const obsoleteValues = unique(values);
    if (!obsoleteValues.length) return;
    const ordinal = events.length;
    events.push({
      id: `memora:${session.persona}:${session.session_id}:${source}:${ordinal}`,
      kind,
      sequence: session.session_id,
      confidence,
      obsoleteValues,
      successorUnitIds: eventSuccessors(session, units, obsoleteValues),
      source,
    });
    sourceCounts[source] = (sourceCounts[source] ?? 0) + 1;
  };

  for (const session of [...sessions].sort((left, right) => left.session_id - right.session_id)) {
    const details = session.operation_details ?? {};
    const effectiveOperation = typeof details.actual_operation === "string"
      ? details.actual_operation
      : session.operation;

    if (session.session_type === "preference") {
      if (effectiveOperation === "update") {
        const oldItem = scalar(details.old_item);
        const polarityChanged = details.old_preference !== undefined
          && details.preference !== undefined
          && details.old_preference !== details.preference;
        addEvent(
          session,
          "update",
          [oldItem, polarityChanged ? scalar(details.item) : null].filter((value): value is string => !!value),
          0.99,
          "structured_preference_update",
        );
      } else if (effectiveOperation === "delete") {
        const item = scalar(details.item);
        addEvent(session, "delete", item ? [item] : [], 0.99, "structured_preference_delete");
      }
      continue;
    }

    if (session.session_type === "goal") {
      const oldValue = scalar(details.old_value);
      if (effectiveOperation === "update" && oldValue) {
        addEvent(session, "update", [oldValue], 0.99, "structured_goal_update");
      }
      continue;
    }

    if (session.session_type !== "activity") continue;
    const explicitOldValues: string[] = [];
    for (const update of Array.isArray(details.memory_updates) ? details.memory_updates : []) {
      if (!update || typeof update !== "object") continue;
      const record = update as Record<string, unknown>;
      for (const key of ["updated_from", "old_value", "removed_item"]) {
        explicitOldValues.push(...valuesFrom(record[key], key));
      }
    }
    for (const deletion of Array.isArray(details.memory_deletes) ? details.memory_deletes : []) {
      if (!deletion || typeof deletion !== "object") continue;
      explicitOldValues.push(...valuesFrom((deletion as Record<string, unknown>).removed_item, "removed_item"));
    }
    addEvent(
      session,
      effectiveOperation === "delete" ? "delete" : "update",
      explicitOldValues,
      0.99,
      "structured_activity_delta",
    );

    const key = activityKey(details);
    const item = details.item;
    if (key) {
      const previous = activityState.get(key);
      if (effectiveOperation === "update" && previous !== undefined) {
        addEvent(session, "update", changedOldValues(previous, item), 0.9, "state_diff_activity_update");
      } else if (effectiveOperation === "delete") {
        addEvent(
          session,
          "delete",
          valuesFrom(previous ?? item),
          0.95,
          "state_activity_delete",
        );
      }
      if (effectiveOperation === "delete") activityState.delete(key);
      else if (item !== undefined) activityState.set(key, item);
    }
  }

  return { events, sourceCounts };
}
