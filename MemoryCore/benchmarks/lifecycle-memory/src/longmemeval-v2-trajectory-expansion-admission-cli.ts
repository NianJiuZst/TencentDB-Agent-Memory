import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildTrajectoryExpansionPhaseAdmission } from "./longmemeval-v2-trajectory-expansion-admission.js";

const { values } = parseArgs({
  options: {
    phase: { type: "string" },
    summary: { type: "string" },
    validation: { type: "string" },
    "validator-commit": { type: "string" },
    output: { type: "string" },
  },
});
if (!values.phase || !values.summary || !values.validation
  || !values["validator-commit"] || !values.output) {
  throw new Error(
    "usage: --phase <development|validation> --summary <json> --validation <json>"
      + " --validator-commit <sha> --output <json>",
  );
}
if (values.phase !== "development" && values.phase !== "validation") {
  throw new Error(`invalid D12 admission phase ${values.phase}`);
}
const admission = buildTrajectoryExpansionPhaseAdmission({
  completedPhase: values.phase,
  summaryText: await readFile(resolve(values.summary), "utf8"),
  validationText: await readFile(resolve(values.validation), "utf8"),
  validatorCommit: values["validator-commit"],
});
const outputPath = resolve(values.output);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(admission, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(admission, null, 2)}\n`);
