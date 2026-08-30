# TencentDB Agent Memory 记忆纠错闭环接入与评测

**交付日期：** 2026-08-30　**实现分支：** `codex/lifecycle-memory-integration`

## 1. 结论与方案

本次将既有实验中效果和边界最清楚的 **Lifecycle V1** 接入 TencentDB Agent Memory 的真实 L1 自动召回链路。它不重新训练检索器，而是在检索结果进入提示词之前，用已发布的结构化“旧记忆 ID → 新记忆 ID”纠错边替换过时项；默认一跳、信任权重阈值 0.85、最多展开 64 个后继，并在 10 ms 决策期限、数据损坏、后继缺失或容量异常时返回字节内容与顺序均不变的 Base 前缀。读旁路和反馈采集均默认关闭，可分阶段放量。

选择 V1 而非探索一个新策略的依据是：既有 Memora 条件样本已证明“已知纠错图 + 召回重定向”有效；D16 又表明收益具有明显任务异质性，不能全流量默认开启；D18 证明纯文本自动找前驱的精度不足。因此，本次只接入**可验证的结构化 update/merge 反馈**，不把 D18 的文本自动建链带入生产。

## 2. 闭环如何实现

```text
对话写入 → L1 抽取/去重 → update 或 merge 决策
             │  同作用域前驱存在 + 新记录向量写入成功
             ▼
  lifecycle-events/YYYY-MM-DD.jsonl（本地或 StorageAdapter/COS）
             ▼
关键词 / embedding / SQLite hybrid / TCVDB native-hybrid 召回真实 ID
             ▼
按 team/user/agent/task 隔离并过滤信任权重 → 批量物化后继 → V1 一跳替换
             ▼
字符预算与提示词注入 → mode/redirect/fallback/latency 数值指标 → 后续门禁
```

**反馈获取。** `l1-writer.ts` 复用现有去重器的 update/merge 决策。只有全部 `target_ids` 在相同 L1 作用域内核验成功，且新记录已成功写入向量存储，才追加 released 事件；update/merge 的策略信任权重分别为 0.95/0.90（不是校准概率）。事件保存前驱、新后继、来源、时间和作用域，正文不进入运行指标。追加失败不阻断主写入。

**召回接入。** `auto-recall.ts` 保留各检索后端返回的真实 ID、分数和作用域；旁路读取同作用域 released 事件，按 ID 通过现有 `IMemoryStore` 批量查询后继，并让后继继承前驱检索分数。没有可用事件时走 Base；任一异常或总期限超限时 exact fallback。L1 本来跨 session 使用，因此 `sessionKey` 仅作审计字段，隔离边界为 team/user/agent，以及调用方能提供时的 task。

**工程落点。** 配置与 schema 位于 `src/config.ts`、`openclaw.plugin.json`；持久化及作用域校验位于 `src/core/lifecycle/feedback-store.ts`；生产执行器位于 `production-runtime.ts`；写反馈位于 `src/core/record/l1-writer.ts`；真实召回接入位于 `src/core/hooks/auto-recall.ts`；只上报数值的可观测指标位于 `metric-tracking-recall.ts`。SQLite 使用真实本地存储测试，TCVDB native-hybrid 使用接口契约测试覆盖。

## 3. 数据集、指标与实测结果

| 证据层 | 数据与评测指标 | 结果 | 结论 |
|---|---|---|---|
| 运行时集成（本次新增） | `runtime-integration-v1`，16 类用例 × 25 次；exact case、旧记忆暴露、后继召回、误重定向、跨作用域泄漏、fallback 等价、p95 开销 | 7/7 门禁通过；exact=100%，旧记忆暴露/误重定向/泄漏=0，后继召回与 fallback 等价=100%；本机 p95 增量 **0.303 ms** | 证明接线、隔离和失败回退正确；不是答案质量结论 |
| Memora D16（既有冻结答案实验，本次独立复核） | 200 个未用于前序选择的问题，13 arms；MPA、FAA、FAMA、persona bootstrap CI | Base FAMA 0.1428，V1 0.1570，差值 +0.0142，CI 触零；forgetting n=92 为 +0.0296、recommending n=38 为 +0.0768；remembering MPA -0.0153 | V1 只保留为条件策略，不支持全流量默认开启 |
| Memora D18（本次重跑 27,614 sessions，test=5,954） | 文本事件 precision/recall/F1、kind accuracy、前驱 link precision/recall、p95 | event P/R/F1=0.9789/0.7964/0.8783；link precision=0.2005、任一正确链接率=0.4538，门禁失败 | 禁止纯文本自动建链；采用结构化 update/merge 反馈 |
| LongMemEval-V2 | 固定 SHA 原始集：451 questions、200 trajectories；D11 token、证据支持与独立 gate | 源数据 SHA 审计通过；既有 30 问 D11 注入 token -20.84%，但未调用答案模型；本次独立复核 0 mismatch、最终 source gate 仍失败 | 仅作效率证据，不能声称答案质量非劣 |

运行时结果卡与独立重算记录：`benchmarks/lifecycle-memory/results/runtime-integration/result-card.v1.json`、`independent-validation.v1.json`。核心复现命令：

```bash
npm run eval:lifecycle-runtime-integration
npm run validate:lifecycle-runtime-integration
npm test
npm run test:lifecycle-memory
npm run build:plugin
```

## 4. 接入配置、上线与验收

```json
{
  "recall": {
    "adaptive": { "enabled": false },
    "lifecycle": {
      "feedbackEnabled": true,
      "enabled": false,
      "minConfidence": 0.85,
      "maxHops": 1,
      "maxExpansions": 64,
      "timeoutMs": 10,
      "maxEvents": 5000
    }
  }
}
```

建议先仅开启 `feedbackEnabled` 做影子采集，检查事件可解析率、作用域完整率和后继可物化率；随后对 forgetting/recommending 或明确发生 update/merge 的小流量开启 `enabled`。上线门禁为：跨作用域泄漏=0、fallback 等价=100%、后继可物化率≥99.9%、p95 总增量≤10 ms，并以真实答案正确率/任务成功率不劣于 Base 为最终质量指标。任一门禁失败即关闭读取开关，保留反馈供离线分析。

当前完成的是 auto-recall 提示词注入路径；尚未覆盖独立 memory search 工具调用。也未做真实 COS/TCVDB 服务延迟探针，现有 TCVDB 证据是 native-hybrid 契约测试，本机时延不能外推到生产网络。生产上线前仍需灰度 A/B；本交付支持“闭环已接入且运行时契约通过”，不支持“通用答案质量已提升”或“端到端自动纠错已解决”。
