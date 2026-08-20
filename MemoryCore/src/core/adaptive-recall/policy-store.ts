import { readFile } from "node:fs/promises";
import { validateAdaptiveRecallPolicy } from "./policy.js";
import type { AdaptiveRecallPolicy } from "./types.js";

/** Read-only production loader. Invalid or corrupt files are rejected. */
export async function loadAdaptiveRecallPolicy(path: string): Promise<AdaptiveRecallPolicy> {
  const raw = await readFile(path, "utf8");
  return validateAdaptiveRecallPolicy(JSON.parse(raw));
}
