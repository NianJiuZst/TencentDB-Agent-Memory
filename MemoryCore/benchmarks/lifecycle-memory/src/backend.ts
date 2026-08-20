import { performance } from "node:perf_hooks";
import { getEncoding } from "js-tiktoken";
import { VectorStore } from "../../../src/core/store/sqlite.js";
import { executeConversationSearch } from "../../../src/core/tools/conversation-search.js";
import type { MemoryUnit, RetrievedUnit } from "./types.js";

const encoding = getEncoding("cl100k_base");

export class MemoryCoreGroupBackend {
  private readonly store = new VectorStore(":memory:", 0);

  constructor(units: MemoryUnit[]) {
    this.store.init();
    for (const unit of units) {
      const ok = this.store.upsertL0({
        id: unit.id,
        sessionKey: "memora-headroom",
        sessionId: unit.sessionId,
        teamId: "benchmark-team",
        userId: "benchmark-user",
        agentId: "benchmark-agent",
        role: unit.role,
        messageText: unit.content,
        recordedAt: new Date(unit.timestampMs).toISOString(),
        timestamp: unit.timestampMs,
      }, undefined);
      if (!ok) throw new Error(`MemoryCore rejected L0 unit ${unit.id}`);
    }
  }

  async search(query: string, limit: number): Promise<{ candidates: RetrievedUnit[]; latencyMs: number }> {
    const startedAt = performance.now();
    const result = await executeConversationSearch({ query, limit, vectorStore: this.store });
    const latencyMs = performance.now() - startedAt;
    return {
      candidates: result.results.map((item) => ({
        id: item.id,
        sessionId: item.session_id,
        role: item.role === "assistant" ? "assistant" : "user",
        content: item.content,
        timestampMs: Date.parse(item.recorded_at),
        score: item.score,
        tokenCount: encoding.encode(item.content).length,
      })),
      latencyMs,
    };
  }

  close(): void {
    this.store.close();
  }
}
