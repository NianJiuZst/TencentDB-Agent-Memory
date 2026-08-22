import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  buildLongMemEvalV2StaticQuestionSplit,
  type LongMemEvalV2StaticQuestionMetadata,
} from "./longmemeval-v2-static-split.js";

interface RawQuestionMetadata {
  id?: unknown;
  domain?: unknown;
  environment?: unknown;
  question_type?: unknown;
  eval_function?: unknown;
  image?: unknown;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`LongMemEval-V2 ${field} must be a non-empty string`);
  }
  return value;
}

function metadataOnly(raw: RawQuestionMetadata): LongMemEvalV2StaticQuestionMetadata {
  const id = requiredString(raw.id, "question.id");
  return {
    id,
    domain: requiredString(raw.domain, `${id}.domain`),
    environment: requiredString(raw.environment, `${id}.environment`),
    memoryAbility: requiredString(raw.question_type, `${id}.question_type`),
    evaluator: requiredString(raw.eval_function, `${id}.eval_function`),
    imagePath: raw.image === null || raw.image === undefined
      ? null
      : requiredString(raw.image, `${id}.image`),
  };
}

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    revision: { type: "string" },
    seed: { type: "string", default: "d12-static-trajectory-expansion-20260822-v1" },
    output: { type: "string" },
  },
});
if (!values.data || !values.revision || !values.output) {
  throw new Error(
    "usage: tsx longmemeval-v2-static-split-cli.ts --data <root>"
      + " --revision <revision> --output <json> [--seed value]",
  );
}

const questionsPath = path.join(path.resolve(values.data), "questions.jsonl");
const questionsText = await readFile(questionsPath, "utf8");
const questions = questionsText.split("\n").filter((line) => line.trim())
  .map((line) => metadataOnly(JSON.parse(line) as RawQuestionMetadata));
const split = buildLongMemEvalV2StaticQuestionSplit({
  questions,
  revision: values.revision,
  questionsSha256: createHash("sha256").update(questionsText).digest("hex"),
  seed: values.seed!,
});
await writeFile(path.resolve(values.output), `${JSON.stringify(split, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  protocolVersion: split.protocolVersion,
  population: split.development.length + split.validation.length + split.test.length,
  counts: split.counts,
  canonicalSha256: split.canonicalSha256,
}, null, 2)}\n`);
