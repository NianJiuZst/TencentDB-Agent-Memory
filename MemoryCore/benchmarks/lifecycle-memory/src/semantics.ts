import type { EvidenceAtom } from "./types.js";

export function normalizeEvidence(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function candidateContainsAtom(candidate: { content: string }, atom: EvidenceAtom): boolean {
  const expected = normalizeEvidence(atom.value);
  return expected.length > 0 && normalizeEvidence(candidate.content).includes(expected);
}

export function candidateMatchesCurrentAtom(
  candidate: { content: string; sessionId: string },
  atom: EvidenceAtom,
): boolean {
  return atom.sourceSessionIds.includes(candidate.sessionId) && candidateContainsAtom(candidate, atom);
}

export function candidateMatchesObsoleteAtom(
  candidate: { content: string; sequence: number },
  atom: EvidenceAtom,
): boolean {
  if (!candidateContainsAtom(candidate, atom)) return false;
  if (!Number.isFinite(atom.invalidatedAtSequence)) {
    throw new Error(`obsolete atom ${atom.id} has no valid invalidation sequence`);
  }
  return candidate.sequence < atom.invalidatedAtSequence!;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactObsoleteUnits<T extends { content: string; sequence: number }>(
  units: T[],
  atoms: EvidenceAtom[],
): T[] {
  return units.flatMap((unit) => {
    let content = unit.content;
    for (const atom of atoms) {
      if (!candidateMatchesObsoleteAtom(unit, atom)) continue;
      content = content.replace(new RegExp(escapeRegExp(atom.value), "giu"), "[superseded]");
    }
    const cleaned = content.replace(/\[superseded\]/g, "").trim();
    return cleaned.length > 0 ? [{ ...unit, content: cleaned }] : [];
  });
}
