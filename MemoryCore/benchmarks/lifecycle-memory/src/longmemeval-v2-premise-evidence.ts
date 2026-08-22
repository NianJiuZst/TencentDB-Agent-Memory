import { createHash } from "node:crypto";
import type { LongTaskQuestion, LongTaskState, LongTaskTrajectory } from "./long-task-adapter.js";
import { normalizeLongTaskSupportText } from "./longmemeval-v2-baseline.js";

export type PremiseEvidenceOperator = "between_adjacent" | "boundary_after" | "boundary_before";
export type PremiseEvidenceInventoryKind = "tabs" | "list" | "columns" | "fields" | "actions";

export interface PremiseEvidenceConfig {
  maxTrajectories: number;
  maxStates: number;
  maxInventories: number;
  maxItemsPerInventory: number;
  maxIndexKeys: number;
  maxSupportsPerKey: number;
  maxCapsuleCharacters: number;
  minContextOverlap: number;
  minDistinctTrajectories: number;
  allowedInventoryKinds: PremiseEvidenceInventoryKind[];
}

export interface PremiseEvidenceItem {
  role: string;
  label: string;
  normalized: string;
  sourceLine: number;
}

export interface PremiseEvidenceInventory {
  id: string;
  trajectoryId: string;
  domain: string;
  environment: string;
  stateIndex: number;
  pageTitle: string;
  url: string;
  containerRole: string;
  containerName: string;
  kind: PremiseEvidenceInventoryKind;
  sourceStartLine: number;
  sourceEndLine: number;
  items: PremiseEvidenceItem[];
  normalizedContext: string;
  sourceSha256: string;
}

export type PremiseEvidenceIndexFailureReason =
  | "trajectory_overflow"
  | "state_overflow"
  | "inventory_overflow"
  | "index_key_overflow"
  | "corrupt_accessibility_tree";

export interface PremiseEvidenceIndex {
  available: boolean;
  failureReason: PremiseEvidenceIndexFailureReason | null;
  config: PremiseEvidenceConfig;
  inventories: PremiseEvidenceInventory[];
  adjacency: ReadonlyMap<string, PremiseEvidenceInventory[]>;
  terminalAfter: ReadonlyMap<string, PremiseEvidenceInventory[]>;
  terminalBefore: ReadonlyMap<string, PremiseEvidenceInventory[]>;
  trajectories: number;
  states: number;
  skippedOversizedInventories: number;
  supersededInventories: number;
  scopeAdapterId: string;
}

export interface PremiseEvidenceScopeAdapter {
  id: string;
  stateScope(trajectory: LongTaskTrajectory, state: LongTaskState): {
    domain: string;
    environment: string;
  };
}

export type PremiseEvidenceDecisionReason =
  | "accepted"
  | "unsupported_query_operator"
  | "no_structural_witness"
  | "insufficient_context_overlap"
  | "insufficient_source_agreement"
  | "capsule_character_decline"
  | "operational_fallback";

export interface PremiseEvidenceDecision {
  mode: "premise_evidence" | "baseline_noop" | "fallback_baseline";
  usedPremiseEvidence: boolean;
  operator: PremiseEvidenceOperator | null;
  anchors: string[];
  inventoryId: string | null;
  supportingInventoryIds: string[];
  sourceMemoryId: string | null;
  sourceLines: number[];
  contextOverlap: number;
  distinctTrajectorySupport: number;
  capsule: string | null;
  fallback: boolean;
  fallbackReason: PremiseEvidenceIndexFailureReason | null;
  decisionReason: PremiseEvidenceDecisionReason;
  certificateViolations: number;
}

interface AxNode {
  role: string;
  name: string;
  attributes: string;
  sourceLine: number;
  indent: number;
  parent: AxNode | null;
  children: AxNode[];
}

interface QueryRelation {
  operator: PremiseEvidenceOperator;
  anchors: string[];
}

const CONTAINER_ROLES = new Set(["tablist", "list", "row", "group", "section", "region", "navigation"]);
const FIELD_ROLES = new Set(["textbox", "searchbox", "combobox", "checkbox"]);
const ACTION_ROLES = new Set(["button", "link", "tab"]);
const CONTEXT_STOPWORDS = new Set([
  "the", "and", "that", "this", "with", "from", "what", "which", "where", "when", "after",
  "before", "into", "your", "answer", "final", "should", "wrapped", "mark", "using", "working",
  "based", "custom", "page", "form", "website", "portal", "dashboard", "name", "appears", "appear",
]);

function validateConfig(config: PremiseEvidenceConfig): void {
  const positiveIntegers = [
    config.maxTrajectories,
    config.maxStates,
    config.maxInventories,
    config.maxItemsPerInventory,
    config.maxIndexKeys,
    config.maxSupportsPerKey,
    config.maxCapsuleCharacters,
  ];
  if (positiveIntegers.some((value) => !Number.isInteger(value) || value <= 0)
    || !Number.isInteger(config.minContextOverlap) || config.minContextOverlap < 0
    || !Number.isInteger(config.minDistinctTrajectories) || config.minDistinctTrajectories <= 0
    || config.allowedInventoryKinds.length === 0
    || new Set(config.allowedInventoryKinds).size !== config.allowedInventoryKinds.length) {
    throw new Error("invalid premise-evidence configuration");
  }
}

function indentation(value: string): number {
  let score = 0;
  for (const character of value) {
    if (character === "\t") score += 2;
    else if (character === " ") score += 1;
    else break;
  }
  return score;
}

function firstQuotedValue(value: string): string {
  const start = value.search(/['"]/u);
  if (start < 0) return "";
  const quote = value[start];
  let escaped = false;
  for (let index = start + 1; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === quote) return value.slice(start + 1, index).replace(/\\(['"\\])/gu, "$1").trim();
  }
  return "";
}

function parseAxTree(value: string): AxNode[] {
  const roots: AxNode[] = [];
  const stack: AxNode[] = [];
  const lines = value.split("\n");
  for (let sourceLine = 0; sourceLine < lines.length; sourceLine += 1) {
    const raw = lines[sourceLine];
    if (!raw.trim()) continue;
    const indent = indentation(raw);
    const withoutId = raw.trim().replace(/^\[[^\]]+\]\s*/u, "");
    const roleMatch = /^([A-Za-z][A-Za-z0-9]*)\b(.*)$/u.exec(withoutId);
    if (!roleMatch) continue;
    const node: AxNode = {
      role: roleMatch[1].toLowerCase(),
      name: firstQuotedValue(roleMatch[2]),
      attributes: roleMatch[2],
      sourceLine,
      indent,
      parent: null,
      children: [],
    };
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack.at(-1) ?? null;
    node.parent = parent;
    if (parent) parent.children.push(node);
    else roots.push(node);
    stack.push(node);
  }
  return roots;
}

function walk(nodes: readonly AxNode[]): AxNode[] {
  const result: AxNode[] = [];
  const pending = [...nodes].reverse();
  while (pending.length > 0) {
    const node = pending.pop()!;
    result.push(node);
    pending.push(...[...node.children].reverse());
  }
  return result;
}

function descendants(node: AxNode, stopAtContainers: boolean): AxNode[] {
  const result: AxNode[] = [];
  const pending = [...node.children].reverse();
  while (pending.length > 0) {
    const value = pending.pop()!;
    result.push(value);
    if (stopAtContainers && CONTAINER_ROLES.has(value.role)) continue;
    pending.push(...[...value.children].reverse());
  }
  return result;
}

function nearestContextName(node: AxNode): string {
  let cursor: AxNode | null = node;
  while (cursor) {
    const heading = cursor.children.find((child) => child.role === "heading" && child.name);
    if (heading) return heading.name;
    if (cursor.name && cursor.role !== "list" && cursor.role !== "row") return cursor.name;
    cursor = cursor.parent;
  }
  return "";
}

function meaningfulLabel(value: string): boolean {
  const normalized = normalizeLongTaskSupportText(value.replace(/[\uE000-\uF8FF]/gu, " "));
  return Boolean(normalized && normalized.length <= 160 && /[\p{L}\p{N}]/u.test(normalized));
}

function cleanFieldLabel(node: AxNode): string {
  return node.name
    .replace(/^Mandatory - must be populated before Submit\s+/iu, "")
    .replace(/^Read only - cannot be modified\s+/iu, "")
    .replace(/\s+Change\s*$/iu, "")
    .trim();
}

function directListItems(node: AxNode): PremiseEvidenceItem[] {
  const result: PremiseEvidenceItem[] = [];
  for (const listItem of node.children.filter((child) => child.role === "listitem")) {
    const candidates = descendants(listItem, true);
    const semantic = candidates.find((candidate) =>
      (ACTION_ROLES.has(candidate.role) || FIELD_ROLES.has(candidate.role)) && meaningfulLabel(candidate.name))
      ?? candidates.find((candidate) => candidate.role === "statictext" && meaningfulLabel(candidate.name));
    if (semantic) result.push(item(semantic, semantic.name));
  }
  return result;
}

function item(node: AxNode, label: string): PremiseEvidenceItem {
  return {
    role: node.role,
    label,
    normalized: normalizeLongTaskSupportText(label),
    sourceLine: node.sourceLine,
  };
}

function uniqueItems(values: PremiseEvidenceItem[]): PremiseEvidenceItem[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.role}\0${value.normalized}`;
    if (!value.normalized || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function inventoryCandidates(node: AxNode): Array<{
  kind: PremiseEvidenceInventoryKind;
  items: PremiseEvidenceItem[];
}> {
  const deep = descendants(node, false);
  if (node.role === "tablist") {
    return [{ kind: "tabs", items: deep.filter((value) => value.role === "tab" && meaningfulLabel(value.name))
      .map((value) => item(value, value.name)) }];
  }
  if (node.role === "list") return [{ kind: "list", items: directListItems(node) }];
  if (node.role === "row") {
    const headers = deep.filter((value) => value.role === "columnheader" && meaningfulLabel(value.name));
    const cells = deep.filter((value) => value.role === "gridcell" && meaningfulLabel(value.name));
    return [{ kind: "columns", items: (headers.length >= 2 ? headers : cells)
      .map((value) => item(value, value.name)) }];
  }
  const local = descendants(node, true);
  const fields = local.filter((value) => FIELD_ROLES.has(value.role))
    .map((value) => item(value, cleanFieldLabel(value))).filter((value) => meaningfulLabel(value.label));
  const actions = local.filter((value) => ACTION_ROLES.has(value.role) && meaningfulLabel(value.name))
    .map((value) => item(value, value.name));
  return [{ kind: "fields", items: fields }, { kind: "actions", items: actions }];
}

function normalizeUrlForContext(value: string): string {
  try {
    const parsed = new URL(value);
    return `${parsed.hostname} ${parsed.pathname.replace(/[/_.-]+/gu, " ")}`;
  } catch {
    return value.replace(/[/_.?&=-]+/gu, " ");
  }
}

function pageTitle(nodes: readonly AxNode[]): string {
  return walk(nodes).find((node) => node.role === "rootwebarea" && meaningfulLabel(node.name))?.name ?? "";
}

function addBounded(map: Map<string, PremiseEvidenceInventory[]>, key: string,
  inventory: PremiseEvidenceInventory, maxSupports: number): void {
  const values = map.get(key) ?? [];
  if (values.length < maxSupports) values.push(inventory);
  map.set(key, values);
}

function unavailableIndex(config: PremiseEvidenceConfig, reason: PremiseEvidenceIndexFailureReason,
  trajectories: number, states: number, scopeAdapterId = "dataset-native-v1"): PremiseEvidenceIndex {
  return {
    available: false,
    failureReason: reason,
    config,
    inventories: [],
    adjacency: new Map(),
    terminalAfter: new Map(),
    terminalBefore: new Map(),
    trajectories,
    states,
    skippedOversizedInventories: 0,
    supersededInventories: 0,
    scopeAdapterId,
  };
}

export const DATASET_NATIVE_PREMISE_EVIDENCE_SCOPE_ADAPTER: PremiseEvidenceScopeAdapter = {
  id: "dataset-native-v1",
  stateScope: (trajectory) => ({
    domain: trajectory.domain,
    environment: trajectory.environment,
  }),
};

export const LONGMEMEVAL_V2_PREMISE_EVIDENCE_SCOPE_ADAPTER: PremiseEvidenceScopeAdapter = {
  id: "longmemeval-v2-url-scope-v1",
  stateScope: (trajectory, state) => {
    let environment = trajectory.environment;
    try {
      const parsed = new URL(state.url);
      if (parsed.port === "9083") environment = "webarena-cms";
      else if (parsed.port === "9082") environment = "webarena-onestopshop";
      else if (parsed.port === "9080") environment = "webarena-reddit";
      else if (/service-now\.com$/iu.test(parsed.hostname)) environment = "workarena";
    } catch {
      // Preserve the dataset-native environment; selection still has the domain guard.
    }
    return { domain: trajectory.domain, environment };
  },
};

export function buildPremiseEvidenceIndex(params: {
  trajectories: LongTaskTrajectory[];
  config: PremiseEvidenceConfig;
  scopeAdapter?: PremiseEvidenceScopeAdapter;
}): PremiseEvidenceIndex {
  validateConfig(params.config);
  const scopeAdapter = params.scopeAdapter ?? DATASET_NATIVE_PREMISE_EVIDENCE_SCOPE_ADAPTER;
  const trajectories = [...params.trajectories].sort((left, right) => left.id.localeCompare(right.id));
  if (trajectories.length > params.config.maxTrajectories) {
    return unavailableIndex(params.config, "trajectory_overflow", trajectories.length, 0, scopeAdapter.id);
  }
  const states = trajectories.reduce((sum, trajectory) => sum + trajectory.states.length, 0);
  if (states > params.config.maxStates) {
    return unavailableIndex(params.config, "state_overflow", trajectories.length, states, scopeAdapter.id);
  }
  const allowedKinds = new Set(params.config.allowedInventoryKinds);
  const inventoryByScope = new Map<string, PremiseEvidenceInventory>();
  let skippedOversizedInventories = 0;
  let supersededInventories = 0;
  try {
    for (const trajectory of trajectories) {
      for (const state of trajectory.states) {
        const scope = scopeAdapter.stateScope(trajectory, state);
        if (!scope.domain.trim() || !scope.environment.trim()) throw new Error("empty premise evidence scope");
        const roots = parseAxTree(state.observation);
        if (roots.length === 0) throw new Error("empty parsed tree");
        const title = pageTitle(roots);
        for (const node of walk(roots).filter((value) => CONTAINER_ROLES.has(value.role))) {
          for (const candidate of inventoryCandidates(node)) {
            if (!allowedKinds.has(candidate.kind)) continue;
            const items = uniqueItems(candidate.items);
            if (items.length < 1) continue;
            if (items.length > params.config.maxItemsPerInventory) {
              skippedOversizedInventories += 1;
              continue;
            }
            const containerName = nearestContextName(node);
            const sourceStartLine = Math.min(node.sourceLine, ...items.map((value) => value.sourceLine));
            const sourceEndLine = Math.max(node.sourceLine, ...items.map((value) => value.sourceLine));
            const normalizedContext = normalizeLongTaskSupportText([
              title,
              containerName,
              trajectory.goal,
              normalizeUrlForContext(state.url),
            ].join(" "));
            const identity = [
              trajectory.id,
              state.index,
              node.sourceLine,
              candidate.kind,
              items.map((value) => `${value.role}:${value.normalized}`).join("|"),
            ].join("\0");
            const inventory: PremiseEvidenceInventory = {
              id: `lmev2:premise-inventory:${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`,
              trajectoryId: trajectory.id,
              domain: scope.domain,
              environment: scope.environment,
              stateIndex: state.index,
              pageTitle: title,
              url: state.url,
              containerRole: node.role,
              containerName,
              kind: candidate.kind,
              sourceStartLine,
              sourceEndLine,
              items,
              normalizedContext,
              sourceSha256: createHash("sha256").update(state.observation).digest("hex"),
            };
            const scopeKey = [
              trajectory.id,
              normalizeUrlForContext(state.url),
              node.sourceLine,
              node.role,
              containerName,
              candidate.kind,
            ].join("\0");
            if (inventoryByScope.has(scopeKey)) supersededInventories += 1;
            inventoryByScope.set(scopeKey, inventory);
            if (inventoryByScope.size > params.config.maxInventories) {
              return unavailableIndex(
                params.config,
                "inventory_overflow",
                trajectories.length,
                states,
                scopeAdapter.id,
              );
            }
          }
        }
      }
    }
  } catch {
    return unavailableIndex(
      params.config,
      "corrupt_accessibility_tree",
      trajectories.length,
      states,
      scopeAdapter.id,
    );
  }
  const inventories = [...inventoryByScope.values()];
  inventories.sort((left, right) => left.id.localeCompare(right.id));
  const adjacency = new Map<string, PremiseEvidenceInventory[]>();
  const terminalAfter = new Map<string, PremiseEvidenceInventory[]>();
  const terminalBefore = new Map<string, PremiseEvidenceInventory[]>();
  for (const inventory of inventories) {
    for (let index = 0; index + 1 < inventory.items.length; index += 1) {
      const left = inventory.items[index].normalized;
      const right = inventory.items[index + 1].normalized;
      addBounded(adjacency, `${left}\0${right}`, inventory, params.config.maxSupportsPerKey);
      addBounded(adjacency, `${right}\0${left}`, inventory, params.config.maxSupportsPerKey);
    }
    addBounded(terminalBefore, inventory.items[0].normalized, inventory, params.config.maxSupportsPerKey);
    addBounded(terminalAfter, inventory.items.at(-1)!.normalized, inventory, params.config.maxSupportsPerKey);
    if (adjacency.size + terminalAfter.size + terminalBefore.size > params.config.maxIndexKeys) {
      return unavailableIndex(
        params.config,
        "index_key_overflow",
        trajectories.length,
        states,
        scopeAdapter.id,
      );
    }
  }
  return {
    available: true,
    failureReason: null,
    config: params.config,
    inventories,
    adjacency,
    terminalAfter,
    terminalBefore,
    trajectories: trajectories.length,
    states,
    skippedOversizedInventories,
    supersededInventories,
    scopeAdapterId: scopeAdapter.id,
  };
}

function parseQueryRelation(prompt: string): QueryRelation | null {
  const substantive = prompt.split(/\n\s*Mark your final answer\b/iu, 1)[0];
  const quoted = String.raw`[\x60'"]([^\x60'"]+)[\x60'"]`;
  const between = new RegExp(`\\bbetween\\s+${quoted}\\s+and\\s+${quoted}`, "iu").exec(substantive);
  if (between) return { operator: "between_adjacent", anchors: [between[1], between[2]] };
  const after = new RegExp(`\\b(?:below|after)\\s+${quoted}`, "iu").exec(substantive);
  if (after) return { operator: "boundary_after", anchors: [after[1]] };
  const before = new RegExp(`\\b(?:above|before)\\s+${quoted}`, "iu").exec(substantive);
  if (before) return { operator: "boundary_before", anchors: [before[1]] };
  return null;
}

function contextTokens(value: string): string[] {
  return [...new Set(normalizeLongTaskSupportText(value).split(" ").filter((token) =>
    token.length >= 3 && !CONTEXT_STOPWORDS.has(token)))];
}

function contextOverlap(question: LongTaskQuestion, inventory: PremiseEvidenceInventory,
  anchors: readonly string[]): number {
  const anchorTokens = new Set(anchors.flatMap(contextTokens));
  return contextTokens(question.prompt).filter((token) =>
    !anchorTokens.has(token) && ` ${inventory.normalizedContext} `.includes(` ${token} `)).length;
}

function candidateMap(index: PremiseEvidenceIndex, relation: QueryRelation): ReadonlyMap<string,
  PremiseEvidenceInventory[]> {
  if (relation.operator === "between_adjacent") return index.adjacency;
  return relation.operator === "boundary_after" ? index.terminalAfter : index.terminalBefore;
}

function relationKey(relation: QueryRelation): string {
  return relation.anchors.map(normalizeLongTaskSupportText).join("\0");
}

function renderInventory(inventory: PremiseEvidenceInventory): string {
  return inventory.items.map((value) => `"${value.label}"`).join(" -> ");
}

function sourceLinesForRelation(inventory: PremiseEvidenceInventory, relation: QueryRelation): number[] {
  const anchors = new Set(relation.anchors.map(normalizeLongTaskSupportText));
  return [...new Set([
    inventory.sourceStartLine,
    ...inventory.items.filter((value) => anchors.has(value.normalized)).map((value) => value.sourceLine),
    inventory.sourceEndLine,
  ])].sort((left, right) => left - right);
}

function renderCapsule(inventory: PremiseEvidenceInventory, relation: QueryRelation): string {
  const provenance = `${inventory.trajectoryId}:${inventory.stateIndex}`;
  const scope = inventory.containerName || inventory.pageTitle || inventory.kind;
  const observation = `Observed ordered ${inventory.kind} in "${scope}": ${renderInventory(inventory)}.`;
  const conclusion = relation.operator === "between_adjacent"
    ? `The recorded items "${relation.anchors[0]}" and "${relation.anchors[1]}" are adjacent; no recorded item is between them.`
    : relation.operator === "boundary_after"
      ? `The recorded inventory ends at "${relation.anchors[0]}"; no recorded item follows it.`
      : `The recorded inventory starts at "${relation.anchors[0]}"; no recorded item precedes it.`;
  return [
    `[premise-check source=${provenance} lines=${sourceLinesForRelation(inventory, relation).join(",")}]`,
    observation,
    conclusion,
    "Use this scoped observation to verify the question's premise before answering.",
  ].join("\n");
}

function certificateViolations(inventory: PremiseEvidenceInventory, relation: QueryRelation,
  capsule: string): number {
  let violations = 0;
  const normalizedItems = inventory.items.map((value) => value.normalized);
  const anchors = relation.anchors.map(normalizeLongTaskSupportText);
  if (relation.operator === "between_adjacent") {
    const left = normalizedItems.indexOf(anchors[0]);
    const right = normalizedItems.indexOf(anchors[1]);
    if (left < 0 || right < 0 || Math.abs(left - right) !== 1) violations += 1;
  } else if (relation.operator === "boundary_after") {
    if (normalizedItems.at(-1) !== anchors[0]) violations += 1;
  } else if (normalizedItems[0] !== anchors[0]) violations += 1;
  for (const anchor of relation.anchors) {
    if (!normalizeLongTaskSupportText(capsule).includes(normalizeLongTaskSupportText(anchor))) violations += 1;
  }
  if (!capsule.includes(`${inventory.trajectoryId}:${inventory.stateIndex}`)) violations += 1;
  return violations;
}

export function selectPremiseEvidence(params: {
  question: LongTaskQuestion;
  index: PremiseEvidenceIndex;
}): PremiseEvidenceDecision {
  if (!params.index.available) {
    return {
      mode: "fallback_baseline", usedPremiseEvidence: false, operator: null, anchors: [],
      inventoryId: null, supportingInventoryIds: [], sourceMemoryId: null, sourceLines: [],
      contextOverlap: 0, distinctTrajectorySupport: 0, capsule: null, fallback: true,
      fallbackReason: params.index.failureReason, decisionReason: "operational_fallback",
      certificateViolations: 0,
    };
  }
  const relation = parseQueryRelation(params.question.prompt);
  if (!relation) {
    return {
      mode: "baseline_noop", usedPremiseEvidence: false, operator: null, anchors: [],
      inventoryId: null, supportingInventoryIds: [], sourceMemoryId: null, sourceLines: [],
      contextOverlap: 0, distinctTrajectorySupport: 0, capsule: null, fallback: false,
      fallbackReason: null, decisionReason: "unsupported_query_operator", certificateViolations: 0,
    };
  }
  const candidates = (candidateMap(params.index, relation).get(relationKey(relation)) ?? [])
    .filter((inventory) => inventory.domain === params.question.domain
      && inventory.environment === params.question.environment
      && params.index.config.allowedInventoryKinds.includes(inventory.kind)
      && inventory.items.length <= params.index.config.maxItemsPerInventory)
    .map((inventory) => ({
      inventory,
      overlap: contextOverlap(params.question, inventory, relation.anchors),
    })).sort((left, right) =>
      right.overlap - left.overlap
      || left.inventory.items.length - right.inventory.items.length
      || right.inventory.stateIndex - left.inventory.stateIndex
      || left.inventory.id.localeCompare(right.inventory.id));
  if (candidates.length === 0) {
    return {
      mode: "baseline_noop", usedPremiseEvidence: false, operator: relation.operator,
      anchors: relation.anchors, inventoryId: null, supportingInventoryIds: [], sourceMemoryId: null,
      sourceLines: [], contextOverlap: 0, distinctTrajectorySupport: 0, capsule: null, fallback: false,
      fallbackReason: null, decisionReason: "no_structural_witness", certificateViolations: 0,
    };
  }
  const best = candidates[0];
  const matchingTop = candidates.filter((candidate) =>
    candidate.overlap === best.overlap
    && candidate.inventory.kind === best.inventory.kind
    && candidate.inventory.items.map((value) => value.normalized).join("\0")
      === best.inventory.items.map((value) => value.normalized).join("\0"));
  const distinctTrajectories = new Set(matchingTop.map((value) => value.inventory.trajectoryId)).size;
  if (best.overlap < params.index.config.minContextOverlap) {
    return {
      mode: "baseline_noop", usedPremiseEvidence: false, operator: relation.operator,
      anchors: relation.anchors, inventoryId: best.inventory.id,
      supportingInventoryIds: matchingTop.map((value) => value.inventory.id), sourceMemoryId: null,
      sourceLines: [], contextOverlap: best.overlap, distinctTrajectorySupport: distinctTrajectories,
      capsule: null, fallback: false, fallbackReason: null,
      decisionReason: "insufficient_context_overlap", certificateViolations: 0,
    };
  }
  if (distinctTrajectories < params.index.config.minDistinctTrajectories) {
    return {
      mode: "baseline_noop", usedPremiseEvidence: false, operator: relation.operator,
      anchors: relation.anchors, inventoryId: best.inventory.id,
      supportingInventoryIds: matchingTop.map((value) => value.inventory.id), sourceMemoryId: null,
      sourceLines: [], contextOverlap: best.overlap, distinctTrajectorySupport: distinctTrajectories,
      capsule: null, fallback: false, fallbackReason: null,
      decisionReason: "insufficient_source_agreement", certificateViolations: 0,
    };
  }
  const capsule = renderCapsule(best.inventory, relation);
  if (capsule.length > params.index.config.maxCapsuleCharacters) {
    return {
      mode: "baseline_noop", usedPremiseEvidence: false, operator: relation.operator,
      anchors: relation.anchors, inventoryId: best.inventory.id,
      supportingInventoryIds: matchingTop.map((value) => value.inventory.id), sourceMemoryId: null,
      sourceLines: [], contextOverlap: best.overlap, distinctTrajectorySupport: distinctTrajectories,
      capsule: null, fallback: false, fallbackReason: null,
      decisionReason: "capsule_character_decline", certificateViolations: 0,
    };
  }
  const violations = certificateViolations(best.inventory, relation, capsule);
  if (violations > 0) {
    return {
      mode: "fallback_baseline", usedPremiseEvidence: false, operator: relation.operator,
      anchors: relation.anchors, inventoryId: best.inventory.id,
      supportingInventoryIds: matchingTop.map((value) => value.inventory.id), sourceMemoryId: null,
      sourceLines: [], contextOverlap: best.overlap, distinctTrajectorySupport: distinctTrajectories,
      capsule: null, fallback: true, fallbackReason: "corrupt_accessibility_tree",
      decisionReason: "operational_fallback", certificateViolations: violations,
    };
  }
  return {
    mode: "premise_evidence", usedPremiseEvidence: true, operator: relation.operator,
    anchors: relation.anchors, inventoryId: best.inventory.id,
    supportingInventoryIds: matchingTop.map((value) => value.inventory.id),
    sourceMemoryId: `lmev2:raw:${best.inventory.trajectoryId}:${best.inventory.stateIndex}`,
    sourceLines: sourceLinesForRelation(best.inventory, relation), contextOverlap: best.overlap,
    distinctTrajectorySupport: distinctTrajectories, capsule, fallback: false, fallbackReason: null,
    decisionReason: "accepted", certificateViolations: 0,
  };
}
