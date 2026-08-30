# TencentDB Agent Memory 记忆纠错闭环接入与评测

**交付日期：** 2026-08-30　**实现分支：** `codex/lifecycle-memory-integration`

## 1. 结论与方案

本次将 **Lifecycle V1** 接入 TencentDB Agent Memory 的真实 L1 自动召回链路，并新增默认关闭的 **D19 查询感知双状态**。V1 对普通/当前问题只返回 active 新记忆；当用户明确询问“以前是什么”或“如何变化”，D19 才在同一槽位返回 `HISTORICAL / SUPERSEDED` 与 `CURRENT / ACTIVE`。delete/retraction 永不返回旧值。系统仍采用一跳、信任阈值 0.85、最多 64 个后继和 10 ms 期限；异常时回退 V1 或 Base。

新实验表明用户思路有条件价值：60 个受控时序问题中，query-aware 相对 V1 的 criterion accuracy 提高 **28.61 个百分点**；但 150 个自然周级问题没有明确历史/变化查询，query-aware 与 V1 完全相同。无条件双状态虽提高 FAMA 1.47 点，却增加 29.53% token，未过成本门。因此保留 V1 为默认，只把双状态作为显式时序查询的实验路径。

## 2. 闭环如何实现

```text
对话写入 → L1 抽取/去重 → update 或 merge 决策
             │  同作用域前驱存在 + 新记录向量写入成功
             ▼
  lifecycle-events/YYYY-MM-DD.jsonl（本地或 StorageAdapter/COS）
             ▼
关键词 / embedding / SQLite hybrid / TCVDB native-hybrid 召回真实 ID
             ▼
按 team/user/agent/task 隔离并过滤信任权重 → 批量物化后继 → V1 一跳解析
             ▼
查询意图：current/aggregate → 新值；history/change → 带标签旧+新
             ▼
字符预算与提示词注入 → mode/redirect/pair/fallback/latency 指标 → 后续门禁
```

**反馈获取。** `l1-writer.ts` 复用现有去重器的 update/merge 决策。只有全部 `target_ids` 在相同 L1 作用域内核验成功，且新记录已成功写入向量存储，才追加 released 事件；update/merge 的策略信任权重分别为 0.95/0.90（不是校准概率）。事件保存前驱、新后继、来源、时间和作用域，正文不进入运行指标。追加失败不阻断主写入。

**召回接入。** `auto-recall.ts` 保留各检索后端的真实 ID、分数和作用域；旁路批量物化后继并继承前驱分数。查询文本分类器只允许明确 history/change 触发双状态；current/aggregate 精确沿用 V1。渲染失败保留 V1 新值，旁路异常或期限超限 exact fallback Base。L1 跨 session 使用，隔离边界为 team/user/agent 以及可提供时的 task。

**工程落点。** 配置/schema 位于 `config.ts`、`openclaw.plugin.json`；账本与 scope 校验位于 `feedback-store.ts`；时序分类在 `temporal-intent.ts`；解析与双状态渲染在 `production-runtime.ts`、`auto-recall.ts`；写反馈在 `l1-writer.ts`；指标在 `metric-tracking-recall.ts`。SQLite 使用真实存储测试，TCVDB native-hybrid 使用接口契约测试。

## 3. 数据集、指标与实测结果

| 证据层 | 数据与评测指标 | 结果 | 结论 |
|---|---|---|---|
| 运行时集成（本次新增） | `runtime-integration-v1`，16 类用例 × 25 次；exact case、旧记忆暴露、后继召回、误重定向、跨作用域泄漏、fallback 等价、p95 开销 | 7/7 门禁通过；exact=100%，旧记忆暴露/误重定向/泄漏=0，后继召回与 fallback 等价=100%；本机 p95 增量 **0.303 ms** | 证明接线、隔离和失败回退正确；不是答案质量结论 |
| Memora D16（既有冻结答案实验，本次独立复核） | 200 个未用于前序选择的问题，13 arms；MPA、FAA、FAMA、persona bootstrap CI | Base FAMA 0.1428，V1 0.1570，差值 +0.0142，CI 触零；forgetting n=92 为 +0.0296、recommending n=38 为 +0.0768；remembering MPA -0.0153 | V1 只保留为条件策略，不支持全流量默认开启 |
| Memora D19（本次新增答案实验） | 自然 150 题 + 20 组 update × current/history/change=60 题；criterion accuracy、FAMA、token、persona CI | query-aware 时序 accuracy 0.7139→1.0000，+0.2861，CI [+0.2778,+0.2986]；history +0.5250、change +0.3333、current=0；合并 token +6.92% | 思路有条件价值；默认替换门失败 |
| Memora D18（本次重跑 27,614 sessions，test=5,954） | 文本事件 precision/recall/F1、kind accuracy、前驱 link precision/recall、p95 | event P/R/F1=0.9789/0.7964/0.8783；link precision=0.2005、任一正确链接率=0.4538，门禁失败 | 禁止纯文本自动建链；采用结构化 update/merge 反馈 |

运行时与 D19 独立重算均为 0 mismatch；D19 完成 672 reader + 672 crossed-judge 单元，重试/模型不一致/自评均为 0。核心复现命令：

```bash
npm run eval:lifecycle-runtime-integration
npm run validate:lifecycle-runtime-integration
npm run validate:lifecycle-dual-state-e2e
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
      "dualStateMode": "off",
      "minConfidence": 0.85,
      "maxHops": 1,
      "maxExpansions": 64,
      "timeoutMs": 10,
      "maxEvents": 5000
    }
  }
}
```

先仅开启 `feedbackEnabled` 做影子采集；再对小流量开启 `enabled`，仍保持 `dualStateMode=off`；最后只在时序问题灰度 `query_aware`。上线门禁为：跨作用域泄漏=0、delete 旧值暴露=0、fallback 等价=100%、后继可物化率≥99.9%、p95 总增量≤10 ms、双状态误触发率和真实答案正确率不劣于 V1。任一门禁失败关闭对应开关。

当前完成 auto-recall 提示词注入，尚未覆盖独立 memory search 工具；也未做真实 COS/TCVDB 网络延迟。D19 假设结构化 update 边正确，受控时序面板不能证明自动建链、真实查询占比、人类正确性或编程任务收益。交付支持“闭环已接入、双状态对明确时序问题有价值”，不支持“默认策略应替换”或“端到端自动纠错已解决”。
