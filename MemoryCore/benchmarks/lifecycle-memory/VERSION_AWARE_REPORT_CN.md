# 版本/分支感知的多状态记忆闭环

**TencentDB Agent Memory 实现与真实评测**

交付日期：2026-08-31　分支：`codex/version-aware-multistate-memory`　评分前提交：`4d77e6984f81`

## 技术结论

**相对原始 Agent Memory 全局混合召回，本方案在 70 个冻结版本能力题上把答案准确率从 94.29% 提升到 100.00%，提升 5.71 个百分点（95% 区间 [2.86, 8.57]）；更关键的是，期望状态精确选择率从 0% 提升到 100%，跨状态污染率从 100% 降到 0%，平均注入 token 减少 29.04%，召回条目减少 67.86%。70 题中 7 题改善、63 题持平、0 题受损。**

| 相对原始方案 | 答案准确率 | 精确状态选择 | 跨状态污染 | 注入 token | 召回条目 |
|---|---:|---:|---:|---:|---:|
| 版本感知多状态 | **+5.71 点** | **0% → 100%** | **100% → 0%** | **-29.04%** | **-67.86%** |

本文把“原始方案”定义为同一 `performAutoRecall` 生产路径中关闭版本感知、直接使用全局 Top-k 的 `global_latest`，不是手工 mock，也没有更换 Reader 或 Judge。

## 1. 原理：同域更新，跨域并存

线性“旧→新”只适用于同一个有效域。main、release、多个 worktree 和并行 Agent task 可能互相矛盾但同时正确；不同有效域必须并列保存，查询时再按当前环境或问题意图选择。

| `scopeLevel` | 有效域键 | 适用条件 | 典型状态 |
|---|---|---|---|
| repository | repo | 仓库相同 | 项目级构建约定 |
| branch | repo + branch | 再匹配分支 | release 测试命令 |
| worktree | repo + branch + worktree | 再匹配 worktree | 未提交配置、实验环境 |
| task | repo + branch + worktree + task | 再匹配 taskId | 并行任务假设、临时命令 |

`repositoryId`、`worktreeId` 由真实 Git 信息生成不可逆短哈希，不保存远端 URL 或本地路径；`commitSha` 用于溯源，detached worktree 还必须匹配提交号。

| 查询模式 | 系统行为 | 返回形式 |
|---|---|---|
| 普通当前态 | 过滤不适用状态，按 task → worktree → branch → repo 排序 | 只返回当前域，标记 `ACTIVE SCOPE` |
| 比较/迁移/回归/历史 | 同仓库内每个有效域先保留一条，再补齐 | 有界多状态，标记 `VERSION STATE` |
| 明确点名两个分支 | 优先两个 branch 状态，不误带其下所有 task/worktree | 分支、提交、worktree、task 来源标签 |
| 缺少仓库上下文 | scoped 候选全部抑制，仅兼容 legacy unscoped | 不猜当前分支值 |

| 闭环阶段 | 实现方式 | 防污染约束 |
|---|---|---|
| capture | 宿主传 `workspaceDir`、稳定 `taskId` 或显式 `versionContext` | 探测失败返回无上下文，不猜身份 |
| L0→L1 | 版本坐标按 `sessionKey + sessionId + taskId` 延续 | 同会话并行 task 不串域 |
| 写入/纠错 | 去重、update/merge、删除、纠错边只比较精确域键 | 兄弟分支/worktree/task 不被误删或误连 |
| 最终召回 | 真实检索池按 4 倍过取，再做生命周期解析和版本选择 | 正确状态不会被其他分支挤出原始 Top-k |
| 反馈 | 记录意图、抑制数、状态数、fallback、token 和延迟 | 反馈调策略，不自动跨域改写事实 |

## 2. TencentDB Agent Memory 接入与 GitHub 代码

Fork 分支：[NianJiuZst/TencentDB-Agent-Memory · codex/version-aware-multistate-memory](https://github.com/NianJiuZst/TencentDB-Agent-Memory/tree/codex/version-aware-multistate-memory)

| 环节 | GitHub 代码 | 接入职责 |
|---|---|---|
| 作用域模型与选择 | [`version-scope.ts`](https://github.com/NianJiuZst/TencentDB-Agent-Memory/blob/codex/version-aware-multistate-memory/MemoryCore/src/core/lifecycle/version-scope.ts) | 域键、有效性、查询意图、标签、多状态选择 |
| Git/worktree 探测 | [`git-context.ts`](https://github.com/NianJiuZst/TencentDB-Agent-Memory/blob/codex/version-aware-multistate-memory/MemoryCore/src/core/lifecycle/git-context.ts) | 仓库/worktree 身份、detached HEAD、隐私哈希 |
| 并行任务延续 | [`version-context-store.ts`](https://github.com/NianJiuZst/TencentDB-Agent-Memory/blob/codex/version-aware-multistate-memory/MemoryCore/src/core/lifecycle/version-context-store.ts) | 按 session + task 保存坐标 |
| 最终生产召回 | [`auto-recall.ts`](https://github.com/NianJiuZst/TencentDB-Agent-Memory/blob/codex/version-aware-multistate-memory/MemoryCore/src/core/hooks/auto-recall.ts) | 候选过取、生命周期解析、版本筛选和提示标签 |
| 同域写入与去重 | [`l1-dedup.ts`](https://github.com/NianJiuZst/TencentDB-Agent-Memory/blob/codex/version-aware-multistate-memory/MemoryCore/src/core/record/l1-dedup.ts)、[`l1-writer.ts`](https://github.com/NianJiuZst/TencentDB-Agent-Memory/blob/codex/version-aware-multistate-memory/MemoryCore/src/core/record/l1-writer.ts) | 只在完全相同有效域内更新和建边 |

```json
{
  "recall": {
    "lifecycle": {
      "enabled": true,
      "versionAwareMode": "strict",
      "autoDetectGit": true,
      "versionCandidateMultiplier": 4,
      "maxVersionStates": 6
    }
  }
}
```

## 3. 数据集与实验方法

| 数据面板 | 数据来源与规模 | 用途与边界 |
|---|---|---|
| 版本能力 | 10 个受控编程场景 × 7 类题 = 70 题 | 验证 branch、worktree、parallel task、比较、迁移、回归和缺失 scope；状态文本为受控生成 |
| Memora 安全 | 固定提交 `a6493188…`；10 persona 各取 4 题 = 40 题 | 仅验证 legacy unscoped 不退化；是复用公开面板，不是新留出集 |
| Memora 原始规模 | 600 问题、27,614 session、24,856 memory unit | 覆盖 activity/preference/goal 的 add、update、delete 和 no-memory |

| 实验环节 | 冻结方法 | 实际执行量 |
|---|---|---:|
| 三组对照 | 原始全局混合、线性新旧双态、版本感知多状态 | 110 题 × 3 组 |
| Git 状态 | main、release、两个 detached worktree、两个并行 task | 1 个真实仓库 |
| Agent Memory 写入 | 真实 SQLite/FTS5 + `writeMemory` | 50 DB，260 次写入 |
| 最终答案上下文 | `performAutoRecall` + 生命周期 + 版本选择 + 提示预算 | 330 次召回，fallback 0 |
| Reader | MiniMax-M3 与 deepseek-v4-flash | 每模型 250，合计 500 |
| Judge | 每个答案只由另一固定模型逐 criterion 判断 | 500 次，无自评/错配/重试/unclear |
| 不确定性 | 按 10 个场景/persona 做 5,000 次配对聚类 bootstrap | 95% 区间 |
| 独立复算 | 从原始 verdict 重算指标、门槛和哈希 | 500 条，mismatch 0 |

主指标为 criterion accuracy；上下文指标为期望集合精确率、期望状态召回率和污染率；同时记录 token、召回条目和本地耗时。能力题通常同时检查“是否说出正确值”和“是否避免把兄弟状态说成当前值”。

## 4. 实验结果

| 70 题能力面板 | 原始全局混合 | 线性新旧双态 | 版本感知多状态 | 相对原始提升 |
|---|---:|---:|---:|---:|
| criterion accuracy | 94.29% | 67.50% | **100.00%** | **+5.71 点** |
| MPA / FAA / FAMA | 94.29 / 94.29 / 94.29% | 47.14 / 87.86 / 47.14% | **100 / 100 / 100%** | **均 +5.71 点** |
| 期望集合精确率 | 0.00% | 0.00% | **100.00%** | **+100.00 点** |
| 期望状态召回率 | 85.71% | 21.43% | **100.00%** | **+14.29 点** |
| 跨状态污染率 | 100.00% | 100.00% | **0.00%** | **-100.00 点** |
| 平均注入 token | 557.89 | 487.57 | **395.90** | **-29.04%** |
| 平均召回条目 | 4.00 | 2.03 | **1.29** | **-67.86%** |
| 本地平均召回 | 0.622 ms | 0.822 ms | **0.569 ms** | **-8.52%** |

| 能力点 | 原始全局混合 | 版本感知多状态 | 提升 |
|---|---:|---:|---:|
| 分支当前态 | 100.00% | **100.00%** | +0.00 点 |
| worktree 当前态 | 100.00% | **100.00%** | +0.00 点 |
| 并行任务当前态 | 100.00% | **100.00%** | +0.00 点 |
| 分支比较 / 迁移 / 回归 | 100.00% | **100.00%** | +0.00 点；污染由 100% 降到 0% |
| 缺失 scope 弃权 | 60.00% | **100.00%** | **+40.00 点** |

| 稳健性/安全检查 | 结果 |
|---|---|
| 逐题结果（相对原始方案） | **7 改善、63 持平、0 受损** |
| 两位 Reader 方向 | **+2.86 / +8.57 点，方向一致** |
| 40 题 Memora 安全 | 三组提示与答案完全相同；FAMA 2.19% → 2.19%，只证明 legacy 路径不退化 |
| 独立验证 | `passed`；500 条 verdict 全量复算，`mismatchCount = 0` |

## 5. 证据边界

| 已由本实验验证 | 本实验未覆盖 |
|---|---|
| 真实 Git/worktree 探测、隐私坐标、并行 task 延续、SQLite 写入、同域去重、生产召回、版本选择、标签、双 Reader/交叉 Judge、legacy 兼容 | 自动 LLM 总能抽取正确 `scopeLevel`；在线 TCVDB/COS 延迟；复杂 merge/cherry-pick/分支重命名；自然流量冲突率；人类 Judge 标定 |

证据文件：`context-manifest.json`、`evaluations.jsonl`、`summary.json`、`independent-validation.json`。上下文 SHA-256：`2c64c12d…a1960f`；原始评测：`e546f4f9…65ee61`。
