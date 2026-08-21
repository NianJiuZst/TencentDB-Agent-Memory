import { createHash } from "node:crypto";
import { listMemOpsInstanceIds } from "./memops-adapter.js";

export interface MemOpsProfileSplit {
  protocolVersion: "lifecycle-memops-profile-split-v1.0";
  seed: number;
  unit: "profile";
  development: string[];
  validation: string[];
  test: string[];
  counts: Record<"development" | "validation" | "test", {
    profiles: number;
    instances: number;
    operationFamilies: Record<string, number>;
  }>;
  canonicalSha256: string;
}

function profileFromInstance(instanceId: string): string {
  const matched = /^([A-Z]\d+)_/.exec(instanceId);
  if (!matched) throw new Error(`invalid MemOps instance id ${instanceId}`);
  return matched[1];
}

function familyFromInstance(instanceId: string): string {
  const matched = /^[A-Z]\d+_(.+)$/.exec(instanceId);
  if (!matched) throw new Error(`invalid MemOps operation family ${instanceId}`);
  return matched[1];
}

function hashOrder(seed: number, profile: string): string {
  return createHash("sha256").update(`${seed}\0${profile}`).digest("hex");
}

export function buildMemOpsProfileSplit(params: {
  instanceIds: string[];
  seed: number;
}): MemOpsProfileSplit {
  const profiles = [...new Set(params.instanceIds.map(profileFromInstance))].sort((left, right) =>
    hashOrder(params.seed, left).localeCompare(hashOrder(params.seed, right))
      || left.localeCompare(right)
  );
  if (profiles.length !== 100) {
    throw new Error(`MemOps split expects 100 profiles, found ${profiles.length}`);
  }
  const profileSplits = {
    development: profiles.slice(0, 60).sort(),
    validation: profiles.slice(60, 80).sort(),
    test: profiles.slice(80).sort(),
  };
  const counts = Object.fromEntries(Object.entries(profileSplits).map(([name, selected]) => {
    const selectedSet = new Set(selected);
    const instances = params.instanceIds.filter((id) => selectedSet.has(profileFromInstance(id)));
    const operationFamilies: Record<string, number> = {};
    for (const instance of instances) {
      const family = familyFromInstance(instance);
      operationFamilies[family] = (operationFamilies[family] ?? 0) + 1;
    }
    return [name, {
      profiles: selected.length,
      instances: instances.length,
      operationFamilies,
    }];
  })) as MemOpsProfileSplit["counts"];
  const canonical = {
    protocolVersion: "lifecycle-memops-profile-split-v1.0" as const,
    seed: params.seed,
    unit: "profile" as const,
    ...profileSplits,
    counts,
  };
  return {
    ...canonical,
    canonicalSha256: createHash("sha256").update(JSON.stringify(canonical)).digest("hex"),
  };
}

export async function buildMemOpsProfileSplitFromData(
  dataRoot: string,
  seed: number,
): Promise<MemOpsProfileSplit> {
  return buildMemOpsProfileSplit({
    instanceIds: await listMemOpsInstanceIds(dataRoot),
    seed,
  });
}
