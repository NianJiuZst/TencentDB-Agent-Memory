import type { LongTaskQuestion, LongTaskTrajectory } from "./long-task-adapter.js";
import type { MemoryUnit, RetrievedUnit } from "./types.js";

export interface RawStateIndexConfig {
  maxCharacters: number;
  overlapCharacters: number;
  maxChunksPerState: number;
}

export interface PackedLongTaskContext {
  items: RetrievedUnit[];
  injectedTokens: number;
  tokenViolation: boolean;
}

export interface DirectAnswerSupport {
  answerAtoms: string[];
  supportedAtoms: boolean[];
  supportedAtomCount: number;
  answerAtomSupportRecall: number;
  anyAnswerAtomSupported: number;
  allAnswerAtomsSupported: number;
}

export function chunkLongTaskText(text: string, config: RawStateIndexConfig): string[] {
  if (!Number.isInteger(config.maxCharacters) || config.maxCharacters <= 0) {
    throw new Error("raw chunk maxCharacters must be a positive integer");
  }
  if (!Number.isInteger(config.overlapCharacters)
    || config.overlapCharacters < 0
    || config.overlapCharacters >= config.maxCharacters) {
    throw new Error("raw chunk overlapCharacters must be in [0, maxCharacters)");
  }
  if (!Number.isInteger(config.maxChunksPerState) || config.maxChunksPerState <= 0) {
    throw new Error("raw chunk maxChunksPerState must be a positive integer");
  }
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length && chunks.length < config.maxChunksPerState) {
    const end = Math.min(text.length, start + config.maxCharacters);
    const chunk = text.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end === text.length) break;
    start = end - config.overlapCharacters;
  }
  return chunks;
}

export function buildRawStateUnits(params: {
  trajectories: LongTaskTrajectory[];
  config: RawStateIndexConfig;
}): { units: MemoryUnit[]; truncatedStates: number } {
  const trajectories = [...params.trajectories].sort((left, right) => left.id.localeCompare(right.id));
  const units: MemoryUnit[] = [];
  let truncatedStates = 0;
  for (let trajectoryIndex = 0; trajectoryIndex < trajectories.length; trajectoryIndex += 1) {
    const trajectory = trajectories[trajectoryIndex];
    for (const state of trajectory.states) {
      const chunks = chunkLongTaskText(state.observation, params.config);
      const reachableCharacters = params.config.maxCharacters
        + Math.max(0, params.config.maxChunksPerState - 1)
          * (params.config.maxCharacters - params.config.overlapCharacters);
      if (state.observation.length > reachableCharacters) truncatedStates += 1;
      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
        const sequence = trajectoryIndex * 100_000 + state.index * params.config.maxChunksPerState + chunkIndex;
        units.push({
          id: `lmev2:raw:${trajectory.id}:${state.index}:${chunkIndex}`,
          sessionId: trajectory.id,
          role: "assistant",
          content: [
            `[raw-state trajectory=${trajectory.id} state=${state.index} chunk=${chunkIndex}]`,
            `Goal: ${trajectory.goal}`,
            `URL: ${state.url}`,
            chunks[chunkIndex],
          ].join("\n"),
          timestampMs: Date.UTC(2025, 0, 1) + sequence * 1_000,
          sequence,
        });
      }
    }
  }
  return { units, truncatedStates };
}

export function sanitizeLongTaskQuery(prompt: string): string {
  return prompt
    .split(/\n\s*Mark your final answer\b/i, 1)[0]
    .replace(/\s*Put your final answer into \\boxed\{\}[^.]*\.?\s*$/i, "")
    .trim();
}

export function packLongTaskContext(params: {
  candidates: RetrievedUnit[];
  tokenBudget: number;
  resultLimit: number;
}): PackedLongTaskContext {
  const items: RetrievedUnit[] = [];
  let injectedTokens = 0;
  for (const candidate of params.candidates) {
    if (items.length >= params.resultLimit) break;
    if (candidate.tokenCount > params.tokenBudget - injectedTokens) continue;
    items.push(candidate);
    injectedTokens += candidate.tokenCount;
  }
  return {
    items,
    injectedTokens,
    tokenViolation: injectedTokens > params.tokenBudget || items.length > params.resultLimit,
  };
}

export function normalizeLongTaskSupportText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\u2010-\u2015-]/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function answerAtomsForQuestion(question: LongTaskQuestion): string[] | null {
  if (!question.evaluator.startsWith("norm_phrase_set_match")) return null;
  const separators = /(?:^|\|)separators=([^|]+)/.exec(question.evaluator)?.[1] ?? ",;";
  const separatorCharacters = [...new Set([...separators])]
    .map((value) => value.replace(/[\\\]\[-]/g, "\\$&"))
    .join("");
  const parts = question.referenceAnswer.split(new RegExp(`[${separatorCharacters}]`, "u"));
  const atoms = [...new Set(parts.map(normalizeLongTaskSupportText).filter(Boolean))];
  if (atoms.length === 0) throw new Error(`LongMemEval-V2 direct question ${question.id} has no answer atoms`);
  return atoms;
}

export function scoreDirectAnswerSupport(
  question: LongTaskQuestion,
  injected: readonly Pick<RetrievedUnit, "content">[],
): DirectAnswerSupport | null {
  const answerAtoms = answerAtomsForQuestion(question);
  if (!answerAtoms) return null;
  const normalizedUnits = injected.map((item) => ` ${normalizeLongTaskSupportText(item.content)} `);
  const supportedAtoms = answerAtoms.map((atom) =>
    normalizedUnits.some((unit) => unit.includes(` ${atom} `))
  );
  const supportedAtomCount = supportedAtoms.filter(Boolean).length;
  return {
    answerAtoms,
    supportedAtoms,
    supportedAtomCount,
    answerAtomSupportRecall: supportedAtomCount / answerAtoms.length,
    anyAnswerAtomSupported: supportedAtomCount > 0 ? 1 : 0,
    allAnswerAtomsSupported: supportedAtomCount === answerAtoms.length ? 1 : 0,
  };
}
