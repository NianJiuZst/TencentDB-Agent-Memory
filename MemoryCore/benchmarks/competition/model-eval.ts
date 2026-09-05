/** Paid, resumable crossed-model rerun, explicitly separated from local tests. */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
const { values } = parseArgs({ options: { data: { type: "string" }, output: { type: "string", default: "../submission/evidence/model-rerun" } } });
if (!values.data) throw new Error("--data /path/to/Memora/data required");
const output = path.resolve(values.output!); mkdirSync(output, { recursive: true });
const ledgerFile = path.join(output, "budget-ledger.json");
type Entry = { model: string; status: number | string; promptTokens?: number; completionTokens?: number; chargedUpperCny: number };
let entries: Entry[] = [];
try {
  const prior = JSON.parse(readFileSync(ledgerFile, "utf8"));
  if (!Array.isArray(prior.entries) || prior.entries.some((e: Entry) => !Number.isFinite(e.chargedUpperCny) || e.chargedUpperCny < 0)
      || !Number.isFinite(prior.reservedUpperCny) || prior.reservedUpperCny < 0) throw new Error("invalid budget ledger");
  entries = prior.entries;
  // A terminated process may have sent requests whose usage was never saved.
  // Keep their whole reservation as spent before allowing a resumed call.
  if (prior.reservedUpperCny > 0) entries.push({ model: "unknown", status: "recovered_unsettled_reservation", chargedUpperCny: prior.reservedUpperCny });
} catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
let spent = entries.reduce((n, e) => n + e.chargedUpperCny, 0), reserved = 0;
const cap = 200;
// Conservative accounting, not a provider invoice: charge every input/output
// token at CNY 100/M, ignoring cache discounts. Failed/unknown calls retain
// their complete worst-case reservation. Existing spend is loaded on resume.
const unitCny = 100 / 1_000_000;
const save = () => {
  const temporary = `${ledgerFile}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ capCny: cap, accountingCnyPerMillionTokens: 100, chargedUpperCny: spent, reservedUpperCny: reserved, entries }, null, 2) + "\n");
  renameSync(temporary, ledgerFile);
};
save();
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (!["https://api.minimaxi.com/v1/chat/completions", "https://api.deepseek.com/chat/completions"].includes(url)) throw new Error("unapproved model endpoint");
  const body = JSON.parse(String(init?.body));
  const inputUpper = Buffer.byteLength(JSON.stringify(body.messages), "utf8") + 1024;
  const outputUpper = Number(body.max_tokens ?? body.max_completion_tokens);
  if (!Number.isFinite(outputUpper) || outputUpper <= 0 || outputUpper > 8192) throw new Error("invalid output cap");
  const reservation = (inputUpper + outputUpper) * unitCny;
  if (spent + reserved + reservation > cap) throw new Error("CNY 200 conservative budget cap reached");
  reserved += reservation; save();
  let status: number | string = "network_error", charge = reservation, promptTokens: number | undefined, completionTokens: number | undefined;
  try {
    const response = await originalFetch(input, init); status = response.status;
    const payload = await response.clone().json() as any;
    if (Number.isFinite(payload.usage?.prompt_tokens) && Number.isFinite(payload.usage?.completion_tokens)) {
      promptTokens = payload.usage.prompt_tokens; completionTokens = payload.usage.completion_tokens;
      charge = (promptTokens! + completionTokens!) * unitCny;
    }
    return response;
  } finally {
    reserved -= reservation; spent += charge;
    entries.push({ model: body.model, status, promptTokens, completionTokens, chargedUpperCny: charge }); save();
    if (entries.length % 20 === 0) console.log(JSON.stringify({ completedApiCalls: entries.length, conservativeBudgetCny: spent.toFixed(3) }));
  }
};
process.env.TDAI_VERSION_EVAL_PROTOCOL = path.resolve("benchmarks/competition/model-protocol.json");
const { runVersionAwareE2E } = await import("../lifecycle-memory/src/version-aware-e2e-runner.js");
const result = await runVersionAwareE2E({ dataRoot: path.resolve(values.data), contextManifest: path.resolve("../submission/evidence/replayed-context/context-manifest.json"), outputDir: output, concurrency: 4 });
console.log(JSON.stringify({ status: result.status, integrity: result.operationalIntegrity, decision: result.decision, conservativeBudgetCny: spent }, null, 2));
