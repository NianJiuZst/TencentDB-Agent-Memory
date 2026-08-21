import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getEncoding } from "js-tiktoken";
import protocolJson from "../protocol.valid-state-packing-e2e-selection.v1.json" with { type: "json" };
import { loadMemora } from "./adapter.js";
import type { RetrievedUnit } from "./types.js";

type Arm = "v1" | "valid_state_packing";

interface IdentityRow {
  arm: Arm;
  candidateIds: string[];
  caseId: string;
  forgettingBearing: boolean;
  groupId: string;
  period: string;
  persona: string;
  task: string;
}

interface SelectionProtocol {
  protocolVersion: string;
  seed: number;
  source: {
    casesSha256: string;
    summarySha256: string;
    validationSha256: string;
    requiredStatus: "passed";
    selectedPolicyId: string;
  };
  exclusion: { selectionSha256: string; excludedCases: number };
  eligibility: {
    period: string;
    tasks: string[];
    forgettingBearing: boolean;
  };
  sampling: { personas: number; casesPerPersona: number; totalCases: number };
}

export interface FreshSelectionOptions {
  cases: string;
  dataRoot: string;
  excludedSelection: string;
  outputDir: string;
  skipHashVerification?: boolean;
  summary: string;
  validation: string;
}

const protocol = protocolJson as SelectionProtocol;
const encoding = getEncoding("cl100k_base");

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function rowKey(row: IdentityRow): string {
  return `${row.caseId}\0${row.arm}`;
}

function identityOnly(raw: Record<string, unknown>): IdentityRow {
  return {
    arm: raw.arm as Arm,
    candidateIds: raw.candidateIds as string[],
    caseId: raw.caseId as string,
    forgettingBearing: raw.forgettingBearing as boolean,
    groupId: raw.groupId as string,
    period: raw.period as string,
    persona: raw.persona as string,
    task: raw.task as string,
  };
}

export function selectFreshPackingCases(
  rows: IdentityRow[],
  excludedCaseIds: Set<string>,
): Array<{ v1: IdentityRow; candidate: IdentityRow }> {
  const byKey = new Map(rows.map((row) => [rowKey(row), row]));
  const eligible = rows.filter((row) => row.arm === "valid_state_packing"
    && row.period === protocol.eligibility.period
    && protocol.eligibility.tasks.includes(row.task)
    && row.forgettingBearing === protocol.eligibility.forgettingBearing
    && !excludedCaseIds.has(row.caseId))
    .map((candidate) => {
      const v1 = byKey.get(`${candidate.caseId}\0v1`);
      if (!v1) throw new Error(`missing paired V1 selection row ${candidate.caseId}`);
      return { v1, candidate };
    });
  const byPersona = new Map<string, Array<{ v1: IdentityRow; candidate: IdentityRow }>>();
  for (const item of eligible) {
    const selected = byPersona.get(item.candidate.persona) ?? [];
    selected.push(item);
    byPersona.set(item.candidate.persona, selected);
  }
  if (byPersona.size !== protocol.sampling.personas) {
    throw new Error(`fresh answer selection persona mismatch: ${byPersona.size}`);
  }
  return [...byPersona.entries()].sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([persona, items]) => {
      if (items.length < protocol.sampling.casesPerPersona) {
        throw new Error(`insufficient fresh answer cases for ${persona}: ${items.length}`);
      }
      return items.sort((left, right) => {
        const leftHash = sha256(`${protocol.seed}\0${left.candidate.caseId}`);
        const rightHash = sha256(`${protocol.seed}\0${right.candidate.caseId}`);
        return leftHash.localeCompare(rightHash)
          || left.candidate.caseId.localeCompare(right.candidate.caseId);
      }).slice(0, protocol.sampling.casesPerPersona);
    });
}

export async function buildFreshPackingSelection(
  options: FreshSelectionOptions,
): Promise<Record<string, unknown>> {
  const [casesText, summaryText, validationText, excludedText, loaded] = await Promise.all([
    readFile(options.cases, "utf8"),
    readFile(options.summary, "utf8"),
    readFile(options.validation, "utf8"),
    readFile(options.excludedSelection, "utf8"),
    loadMemora(options.dataRoot, !options.skipHashVerification),
  ]);
  const hashes = {
    cases: sha256(casesText),
    summary: sha256(summaryText),
    validation: sha256(validationText),
    excludedSelection: sha256(excludedText),
  };
  if (hashes.cases !== protocol.source.casesSha256
    || hashes.summary !== protocol.source.summarySha256
    || hashes.validation !== protocol.source.validationSha256
    || hashes.excludedSelection !== protocol.exclusion.selectionSha256) {
    throw new Error("fresh answer selection input hash mismatch");
  }
  const summary = JSON.parse(summaryText);
  const validation = JSON.parse(validationText);
  if (summary.status !== protocol.source.requiredStatus
    || validation.status !== protocol.source.requiredStatus
    || summary.optimization.selected.id !== protocol.source.selectedPolicyId) {
    throw new Error("fresh answer selection requires the frozen passed candidate");
  }
  const excluded = JSON.parse(excludedText);
  const excludedCaseIds = new Set<string>(excluded.selected.map((item: Record<string, any>) => item.caseId));
  if (excludedCaseIds.size !== protocol.exclusion.excludedCases) {
    throw new Error("fresh answer exclusion count mismatch");
  }
  const rows = casesText.split("\n").filter(Boolean)
    .map((line) => identityOnly(JSON.parse(line)));
  const selected = selectFreshPackingCases(rows, excludedCaseIds);
  if (selected.length !== protocol.sampling.totalCases
    || selected.some((item) => excludedCaseIds.has(item.candidate.caseId))) {
    throw new Error("fresh answer selection size or overlap mismatch");
  }
  const eligibilityCounts = Object.fromEntries([...new Set(rows.map((row) => row.persona))].sort()
    .map((persona) => [persona, rows.filter((row) => row.arm === "valid_state_packing"
      && row.persona === persona
      && row.period === protocol.eligibility.period
      && protocol.eligibility.tasks.includes(row.task)
      && row.forgettingBearing === protocol.eligibility.forgettingBearing
      && !excludedCaseIds.has(row.caseId)).length]));
  const selection = {
    protocolVersion: protocol.protocolVersion,
    seed: protocol.seed,
    input: { hashes, eligibleByPersona: eligibilityCounts },
    excludedCases: excludedCaseIds.size,
    selected: selected.map(({ v1, candidate }) => ({
      caseId: candidate.caseId,
      groupId: candidate.groupId,
      persona: candidate.persona,
      period: candidate.period,
      task: candidate.task,
      v1CandidateIds: v1.candidateIds,
      validStatePackingCandidateIds: candidate.candidateIds,
    })),
  };
  const selectionText = `${JSON.stringify(selection, null, 2)}\n`;
  const groups = new Map(loaded.groups.map((group) => [group.id, group]));
  const manifestCases = selection.selected.map((entry) => {
    const group = groups.get(entry.groupId);
    if (!group) throw new Error(`missing fresh answer group ${entry.groupId}`);
    const units = new Map(group.units.map((unit) => [unit.id, unit]));
    const materialize = (ids: string[]): RetrievedUnit[] => ids.map((id) => {
      const unit = units.get(id);
      if (!unit) throw new Error(`missing fresh answer candidate ${entry.groupId}/${id}`);
      return { ...unit, score: 0, tokenCount: encoding.encode(unit.content).length };
    });
    return {
      caseId: entry.caseId,
      groupId: entry.groupId,
      persona: entry.persona,
      period: entry.period,
      task: entry.task,
      arms: {
        v1: materialize(entry.v1CandidateIds),
        valid_state_packing: materialize(entry.validStatePackingCandidateIds),
      },
    };
  });
  const manifest = {
    protocolVersion: protocol.protocolVersion,
    selectionSha256: sha256(selectionText),
    datasetRevision: loaded.description.revision,
    cases: manifestCases,
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  await mkdir(options.outputDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(options.outputDir, "selection.json"), selectionText, "utf8"),
    writeFile(path.join(options.outputDir, "context-manifest.json"), manifestText, "utf8"),
  ]);
  return {
    status: "passed",
    protocolVersion: protocol.protocolVersion,
    cases: selection.selected.length,
    personas: new Set(selection.selected.map((item) => item.persona)).size,
    overlapWithExcluded: selection.selected.filter((item) => excludedCaseIds.has(item.caseId)).length,
    selectionSha256: sha256(selectionText),
    contextManifestSha256: sha256(manifestText),
    eligibleByPersona: eligibilityCounts,
  };
}
