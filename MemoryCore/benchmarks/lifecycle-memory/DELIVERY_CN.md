# TencentDB Agent Memory 查询感知双态记忆闭环

**交付日期：** 2026-08-31　**分支：** `codex/lifecycle-memory-integration`　**预评分提交：** `59129af`

## 1. 最终结论

最终方案已经接入 `performAutoRecall` 生产链路，并重新完成答案评测。系统不全量删除历史，也不把历史无条件塞给模型：普通问题和当前态问题只返回 `CURRENT / ACTIVE`；明确询问“以前是什么”或“如何变化”时，在一个候选槽内同时返回带标签的 `HISTORICAL / SUPERSEDED` 与 `CURRENT / ACTIVE`；删除或撤回关系永不返回旧内容。

在 60 个时序问题上，criterion accuracy 从 **72.22% 提升至 99.58%**，提高 **27.36 个百分点**，人格聚类 bootstrap 95% 区间为 **[26.53, 27.78]**；历史问题提高 **48.75** 点，变化问题提高 **33.33** 点，当前态问题差值为 **0**。150 个自然问题的最终提示和 FAMA 均不变。全部 210 题的平均注入 token 仅增加 **0.54%**。500 个答案与 500 个异模型判分全部完成，独立复算 `mismatchCount = 0`。因此建议采用查询感知双态，但仅对明确历史/变化查询开放。

## 2. 闭环如何实现

```text
L1 抽取与去重 → update / merge
        │ 旧 ID 同作用域核验 + 新记录已可查询
        ▼
追加生命周期事件（本地或 COS）
        ▼
真实 ID 召回 → 可信边过滤 → 物化后继 → 当前态解析
        ▼
查询文本路由：普通/当前/汇总 → 当前态；历史/变化 → 新旧双态
        ▼
最终提示注入 → mode/redirect/pair/fallback/latency → 答案门禁
```

**反馈获取。** `src/core/record/l1-writer.ts` 复用现有去重器的 `update` / `merge` 与 `target_ids`。只有所有旧 ID 在相同 team/user/agent/task 边界内核验成功，并且新记录向量 `upsert` 成功，才调用 `appendLifecycleFeedbackEvent` 发布前驱到后继的结构化事件。事件包含 ID、来源、时间、权重和作用域；正文不进入运行指标。update/merge 的门控权重分别为 0.95/0.90，追加失败不阻断主写入。

**召回执行。** `src/core/hooks/auto-recall.ts` 保留 keyword、embedding、SQLite hybrid、TCVDB native-hybrid 的真实候选 ID、分数和作用域；`production-runtime.ts` 加载同作用域且权重不低于 0.85 的事件，批量物化后继、继承前驱分数并执行一跳解析；`temporal-intent.ts` 只读问题文本，只有历史态和状态变化可触发双态。账本异常或 10 ms 超时回退原检索前缀；双态渲染异常保留当前态结果。

**代码落点。** 配置/schema：`src/config.ts`、`openclaw.plugin.json`；写入反馈：`src/core/record/l1-writer.ts`；账本与隔离：`src/core/lifecycle/feedback-store.ts`；解析与双态：`src/core/lifecycle/production-runtime.ts`；最终注入：`src/core/hooks/auto-recall.ts`；指标：`src/core/report/metric-tracking-recall.ts`。

## 3. 怎么验证、提升了什么

数据为固定修订的 Memora，覆盖 10 个 persona。自然面板包含 150 个完整周级问题；时序面板由 20 组结构化偏好更新分别生成当前、历史、变化问题，共 60 题。对照为“当前态单路”，实验组为“查询感知双态”。

评测没有重构候选文本：两组均真实执行配置解析、持久化事件、作用域过滤、后继物化、查询路由、预算及最终 `prependContext` / `appendSystemContext`。候选顺序通过冻结的 `IMemoryStore` 契约适配器固定，因此没有测真实 SQLite、TCVDB 或 COS 网络延迟。

| 面板 | n | 当前态单路 | 查询感知双态 | 差值与 95% 区间 |
|---|---:|---:|---:|---:|
| 自然问题 FAMA | 150 | 28.72% | 28.72% | 0.00 点 [0.00, 0.00] |
| 当前态 accuracy | 20 | 100.00% | 100.00% | 0.00 点 [0.00, 0.00] |
| 历史态 accuracy | 20 | 50.00% | 98.75% | **+48.75 点 [46.25, 50.00]** |
| 状态变化 accuracy | 20 | 66.67% | 100.00% | **+33.33 点 [33.33, 33.33]** |
| 全部时序 accuracy | 60 | 72.22% | 99.58% | **+27.36 点 [26.53, 27.78]** |

时序问题中 40 题改善、20 题持平、0 题受损；两个 Reader 的时序方向分别为 +27.78 和 +26.94 点。整体平均注入 token 为 549.20 → 552.19（+0.54%）。

生产上下文阶段执行 420 次 `performAutoRecall`，召回错误、生命周期回退、配对异常和非触发提示差异均为 0；得到每个 Reader 250 个唯一提示。答案阶段完成 500 Reader + 500 crossed Judge 调用，Reader 重试 0、Judge 可恢复重试 3、模型错配 0、自评 0。独立验证从 500 条原始 verdict 重新计算全部指标、区间、门槛和文件哈希，差异为 0。MemoryCore 常规测试 80/80、生命周期 benchmark 测试 159/159，聚焦类型检查与插件构建均通过。

## 4. 配置与上线

```json
{
  "recall": {
    "lifecycle": {
      "feedbackEnabled": true,
      "enabled": true,
      "dualStateMode": "query_aware",
      "minConfidence": 0.85,
      "maxHops": 1,
      "maxExpansions": 64,
      "timeoutMs": 10,
      "maxEvents": 5000
    }
  }
}
```

先只开启反馈做影子采集；再小流量开启当前态解析；最后灰度 `query_aware`。上线门禁：跨作用域泄漏=0，删除旧值暴露=0，后继可物化率≥99.9%，p95 总增量≤10 ms，历史/变化答案正确率不劣化。失败时关闭读取开关，保留影子反馈。

## 5. 证据边界

本次证明的是“正确结构化更新边经过最终自动召回后，受控返回带标签新旧状态能改善历史与变化答案，并保持当前和普通问题不变”。尚未证明纯文本自动建链、真实历史查询占比、人类裁判一致性、真实 COS/TCVDB 网络时延、多轮编程任务收益或独立 memory search 工具路径。冻结周级问题曾用于此前开发，因此结果属于新调用、可复算的生产链路答案证据，不是全新外部留出集。
