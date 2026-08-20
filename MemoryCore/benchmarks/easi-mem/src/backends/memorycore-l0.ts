import { performance } from "node:perf_hooks";
import { getEncoding } from "js-tiktoken";
import { VectorStore } from "../../../../src/core/store/sqlite.js";
import { executeConversationSearch } from "../../../../src/core/tools/conversation-search.js";
import type { BackendSearchResult, EvalCase, MemoryBackendAdapter } from "../types.js";

const encoding = getEncoding("cl100k_base");

export class MemoryCoreL0FtsBackend implements MemoryBackendAdapter {
  readonly name = "memorycore-l0-sqlite-fts5";

  async indexAndSearch(evalCase: EvalCase, candidateLimits: number[]): Promise<BackendSearchResult> {
    const store = new VectorStore(":memory:", 0);
    store.init();
    const indexStartedAt = performance.now();

    try {
      for (const turn of evalCase.turns) {
        const ok = store.upsertL0({
          id: turn.id,
          sessionKey: evalCase.id,
          sessionId: turn.sessionId,
          teamId: "benchmark-team",
          userId: "benchmark-user",
          agentId: "benchmark-agent",
          role: turn.role,
          messageText: turn.content,
          recordedAt: new Date(turn.timestampMs || 0).toISOString(),
          timestamp: turn.timestampMs,
        }, undefined);
        if (!ok) throw new Error(`MemoryCore rejected L0 record ${turn.id}`);
      }
      const indexLatencyMs = performance.now() - indexStartedAt;
      const limits = [...new Set(candidateLimits)].sort((left, right) => right - left);
      if (limits.length === 0 || limits.some((limit) => !Number.isInteger(limit) || limit < 1)) {
        throw new Error("candidateLimits must contain positive integers");
      }
      const queryLatencyByLimit: Record<string, number> = {};
      let result: Awaited<ReturnType<typeof executeConversationSearch>> | undefined;
      for (const limit of limits) {
        const queryStartedAt = performance.now();
        const current = await executeConversationSearch({
          query: evalCase.query,
          limit,
          vectorStore: store,
        });
        queryLatencyByLimit[String(limit)] = performance.now() - queryStartedAt;
        if (!result) result = current;
      }

      return {
        candidates: result!.results.map((item) => ({
          id: item.id,
          content: item.content,
          score: item.score,
          sourceId: item.session_id,
          timestampMs: Date.parse(item.recorded_at),
          tokenCount: encoding.encode(item.content).length,
          metadata: {
            role: item.role,
            sessionKey: item.session_key,
          },
        })),
        indexedItems: evalCase.turns.length,
        indexLatencyMs,
        queryLatencyMs: queryLatencyByLimit[String(limits[0])],
        queryLatencyByLimit,
        strategy: result!.strategy,
      };
    } finally {
      store.close();
    }
  }
}
