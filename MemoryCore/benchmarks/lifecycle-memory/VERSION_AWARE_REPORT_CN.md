# 版本/分支感知的多状态记忆闭环

**TencentDB Agent Memory 实现原理与真实评测**

交付日期：2026-08-31　分支：`codex/version-aware-multistate-memory`　评分前提交：`4d77e6984f81`

## 技术结论

版本感知多状态记忆把线性的“旧状态—新状态”关系扩展为仓库、分支、worktree、并行任务四级有效域。同一有效域内，后续事实可以更新前序事实；不同有效域之间，即使内容互相矛盾，也被视为可以同时成立的并列状态。普通执行只返回当前有效域内的状态；比较、迁移、回归和历史问题才返回同仓库的多个带标签状态；缺少仓库上下文时，不注入任何有作用域记忆。

真实答案评测中，新方案在 70 个版本能力题上的 criterion accuracy 为 **100.00%**：相比全局混合召回的 94.29% 提升 **5.71 个百分点**（95% 区间 [2.86, 8.57]），相比线性新旧双态的 67.50% 提升 **32.50 点**（[30.36, 34.64]）。在回答生成之前，期望状态精确选择率由两组基线的 0% 提升到 **100%**，跨状态污染率由 100% 降到 **0%**，能力面板平均注入 token 分别减少 **29.04%** 和 **18.80%**。

全局混合基线在简单题上已经较强，因此答案分数的直接提升小于上下文质量提升。受控记忆正文包含 `State owner`，强模型在看到多个状态时仍能自行消歧；但其期望集合精确率仍为 0%、污染率仍为 100%。本方案的主要作用，是把“让模型猜哪个状态有效”改成“系统先验证有效域，再把必要状态交给模型”。

## 1. 为什么线性新旧链不足

“新记忆替代旧记忆”隐含了一个前提：两个事实描述的是同一个世界状态。在长期编程任务中，这个前提经常不成立。例如 main 与 release 的测试命令、两个 worktree 的未提交配置、同一 worktree 中两个 Agent 任务正在验证的假设，都可能互相矛盾但同时正确。若按写入时间把它们串成一条链，最近写入的任务会错误覆盖另一个仍在运行的任务。

因此，线性新旧双态不是被删除，而是成为多状态模型中的一个特例：只有两个事实的有效域完全相同，才能讨论谁更新谁；有效域不同，则保留为并列状态，并在查询时按当前执行环境或查询意图选择。

## 2. 状态坐标与有效性判定

每条 L1 记忆携带结构化坐标：

```text
M = (content, repositoryId, branch, commitSha,
     worktreeId, taskId, scopeLevel, provenance)
```

其中 `repositoryId` 和 `worktreeId` 是不可逆短哈希；原始远端 URL、本地绝对路径不进入记忆。`commitSha` 用于溯源，通常不作为普通分支状态的唯一有效域；detached worktree 例外，必须同时匹配提交号，避免同名 `HEAD` 状态串用。

| `scopeLevel` | 有效域键 | 对当前执行环境的适用条件 | 典型内容 |
|---|---|---|---|
| repository | repo | 仓库相同 | 项目级构建约定、目录结构 |
| branch | repo + branch | 仓库、分支相同 | release 分支测试命令 |
| worktree | repo + branch + worktree | 再匹配 worktree | 本地未提交配置、实验环境 |
| task | repo + branch + worktree + task | 再匹配稳定 taskId | 并行 Agent 的假设、临时命令 |

实现遵守四条不变量：

1. **同仓库不等于同状态。** sibling branch、worktree 和 task 不能因语义相似或写入更晚而互相更新。
2. **写入域与读取域一致。** 去重、update/merge、删除和纠错边都使用同一个精确有效域键。
3. **越具体的状态优先。** 普通查询按 task → worktree → branch → repository 排序；具体状态存在时，旧式无作用域记忆不参与竞争。
4. **缺少可信上下文时弃权。** 无法获得当前仓库坐标时，仅保留兼容的 legacy unscoped 记忆，所有 scoped 记忆都被抑制。

## 3. 写入闭环如何工作

### 3.1 获取执行上下文

OpenClaw 或 Gateway 在 capture 时传入 `workspaceDir`、稳定 `taskId`，也可以直接传入显式 `versionContext`。Git 探测器执行只读命令得到仓库共同目录、当前分支、HEAD 和 worktree 顶层目录：

- 有远端时，用规范化后的远端身份生成 `repositoryId`；无远端时，用 Git common-dir 生成本地仓库身份。
- 用 worktree 顶层目录生成 `worktreeId`，因此多个 worktree 共享仓库身份但具有不同 worktree 身份。
- 无分支名的 detached HEAD 记为 `detached@<commit>`。
- 探测结果缓存 2 秒，单次 Git 命令默认超时 250 ms；探测失败返回无上下文，不猜测仓库身份。

### 3.2 上下文延续到异步 L1

capture 首先写入 L0，L0 仍保留 team、user、agent、session、task 等隔离字段。版本坐标按 `sessionKey + sessionId + taskId` 的哈希键持久化，异步 L0→L1 管线重新加载同一坐标。把 `taskId` 放入持久化键，解决了同一会话内多个并行任务后写入者覆盖前写入者的问题。

### 3.3 同域更新，跨域并存

生成 L1 候选后，`l1-dedup.ts` 和 `l1-writer.ts` 先做原有租户隔离，再要求 `memoryVersionWriteDomainsEqual`。分支级键由 repo + branch 构成，worktree 级键再加入 worktree，task 级键再加入 task。只有精确域相同的旧记录才可能被去重、合并或建立纠错边。

纠错链仍保留审计性：原始证据不因新记录写入而物理消失；新记录可查询、旧 ID 全部核验且置信度达到门槛后，读取侧才解析同域前驱—后继关系。跨域记录不会进入旧 ID 集合，因此兄弟分支、worktree 或任务不会被误删、误连或重定向。

## 4. 召回闭环如何工作

### 4.1 从真实检索池过取候选

最终路径是 `performAutoRecall`，不是手工排列的内存数组。MemoryCore 先通过 SQLite/FTS5、embedding 或 hybrid/RRF 检索候选；严格模式将候选上限扩为最终 `maxResults` 的 `versionCandidateMultiplier` 倍，本实验为 4 倍。这样可以在相关性排序之后再做作用域筛选，避免正确分支状态因其他分支占满 Top-k 而无法进入选择器。

### 4.2 先解析同域生命周期，再选择版本视图

候选先经过生命周期纠错解析，再进入 `selectVersionAwareCandidates`。版本选择器根据问题文本识别五类意图：当前态、作用域比较、迁移、回归、历史。其行为如下：

| 查询模式 | 候选范围 | 选择规则 | 最终标签 |
|---|---|---|---|
| 当前执行 | 当前仓库的有效状态 | 过滤不适用状态，按 task → worktree → branch → repo 排序 | `ACTIVE SCOPE` |
| 比较/迁移/回归/历史 | 当前仓库的多个状态 | 显式分支优先，每个有效域先保留一条，再按原检索顺序补齐 | `VERSION STATE` |
| 明确点名两个分支 | 两个分支对应状态 | 有 branch 级状态时不误带入分支下所有 task/worktree | 分支、提交、worktree、task、scope |
| 缺少仓库上下文 | legacy unscoped | scoped 候选全部弃权 | 无版本标签 |

多状态返回受到两层边界控制：`maxVersionStates` 限制不同状态数，本实验为 6；最终仍受 `resultLimit` 和提示 token 预算约束。标签额外包含 `active_here=yes/no`，使回答模型可以区分“当前环境状态”和“仅用于比较的其他状态”。

### 4.3 反馈如何形成闭环

线上决策日志记录查询意图、作用域状态、输入候选数、被抑制数量、带标签状态数、当前有效状态数、fallback 和延迟。答案质量由离线 Reader/Judge 或人工反馈评估；反馈用于调整候选倍数、意图识别、最大状态数和作用域生成策略，不自动触发跨域改写。闭环的控制对象是检索策略，而不是把某次模型判断直接写成新的全局事实。

## 5. TencentDB Agent Memory 接入位置

| 环节 | 代码位置 | 实际职责 |
|---|---|---|
| 数据模型与选择 | `src/core/lifecycle/version-scope.ts` | 坐标校验、域键、有效性、意图、标签、多状态选择 |
| Git/worktree 探测 | `src/core/lifecycle/git-context.ts` | 同仓库身份、不同 worktree 身份、detached HEAD、隐私哈希 |
| 异步上下文延续 | `version-context-store.ts`、`pipeline-factory.ts` | 按会话和 task 保存坐标，防止并行任务串域 |
| 写入与去重 | `l1-dedup.ts`、`l1-writer.ts` | 只在相同有效域更新、删除和建立纠错边 |
| 最终生产召回 | `auto-recall.ts` | 真实候选过取、生命周期解析、版本筛选、标签和提示预算 |
| 宿主入口 | `tdai-core.ts`、`index.ts`、`gateway/*` | OpenClaw 与 Gateway 传入工作区、task 和显式坐标 |

参考配置：

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

自动探测默认使用保守的 worktree 级作用域；存在并行任务时应传稳定 `taskId`。确实需要跨 worktree 共享的分支级事实，应由宿主明确传入 `scopeLevel: "branch"`，而不是让抽取模型根据正文猜测。

## 6. 测试数据集

### 6.1 版本能力面板：70 个受控生成题

该面板专门验证版本作用域能力，由 10 个独立编程状态场景 × 7 类问题组成，共 70 题。状态文本由实验生成，因此它不是自然分布数据；但每条状态都通过真实 Git、真实 SQLite 和 Agent Memory 最终召回路径执行。

| 问题切片 | 每类题数 | 期望行为 |
|---|---:|---|
| branch current | 10 | 只返回当前分支事实 |
| worktree current | 10 | 同分支下只返回当前 worktree 事实 |
| parallel task current | 10 | 同 worktree 下只返回当前 task 事实 |
| branch comparison | 10 | 同时返回两个指定分支并正确标注 |
| migration | 10 | 返回迁移两端所需状态，不混入无关 task |
| regression | 10 | 返回用于定位变化的相关状态集合 |
| missing scope abstention | 10 | 没有仓库坐标时不选择任何 scoped 当前值 |

实验仓库包含 main、release、两个 detached worktree 和 `parallel-alpha`、`parallel-beta` 两个并行任务；worktree 状态同时落到真实文件中。所有 worktree 产生相同 `repositoryId`、不同 `worktreeId`，原始路径没有进入结果文件。

### 6.2 Memora 公开安全面板：40 题

外部数据来自公开 Memora 仓库固定提交 `a6493188efc836d6511ed5e4163fe3ba87da30ff`。该版本共包含 30 个 group、10 个 persona、600 个问题、27,614 个 session 和 24,856 个 memory unit，覆盖 activity、preference、goal 的 add/update/delete 以及 no-memory 情况。

本实验没有使用全部 600 题，而是从先前已冻结的 weekly 自然题中，对 10 个 persona 各按字典序取前 4 题，共 40 题。选择发生在读取新答案和 verdict 之前。三组方案对这些旧式无作用域记忆生成逐字节相同的提示，因此该面板只回答一个安全问题：开启版本逻辑后，legacy unscoped 路径是否退化。它是复用的公开安全面板，不是新的外部留出集，也不用于证明版本能力。

## 7. 实验方法

### 7.1 三组对照方案

1. **全局混合召回 `global_latest`**：不做版本过滤，把相关性最高的所有状态视为可直接使用。
2. **线性新旧双态 `old_current_dual`**：故意把并行分支、worktree、task 串成一条 old→current 链，用来复现双态设计的语义限制。
3. **版本感知多状态 `version_aware_multistate`**：普通问题只选当前有效域；比较类问题返回同仓库的带标签多状态；缺少上下文时弃权。

### 7.2 真实生产路径执行

上下文生成共使用 1 个真实 Git 仓库、50 个独立 SQLite/FTS5 数据库，执行 260 次 `writeMemory` 和 330 次 `performAutoRecall`。没有使用确定性 `IMemoryStore` 排名替身，也没有在评分脚本里手工指定召回顺序。330 个 case-arm 上下文全部经过关键词检索、生命周期处理、版本选择、提示预算和最终 prepend/append 构造；fallback 为 0。

上下文验证要求：真实 Git、多个 worktree 共享仓库身份且 worktree 身份不同、真实 SQLite、调用数完整、当前态集合无误、比较集合完整、缺失 scope 正确弃权、自然安全题三组提示逐字节一致。最终这 9 类检查全部通过，版本当前态、比较集、缺失 scope 和自然提示 mismatch 均为 0。

### 7.3 Reader/Judge 答案评测

110 题 × 3 组形成 330 个题组上下文。由于 40 个自然安全题的三组提示逐字节相同，只在同一冻结 case 内复用完全相同的消息数组，最终每个 Reader 运行 250 个唯一提示：

- Reader：MiniMax-M3，temperature 0.1，top-p 0.95，thinking disabled。
- Reader：deepseek-v4-flash，temperature 0，thinking disabled。
- 每个答案只交给另一个模型 Judge，禁止自评。
- 总计 500 次真实 Reader 调用和 500 次真实 Judge 调用；Reader/Judge 重试、模型错配、自评和 unclear verdict 均为 0。

Judge 不直接给一个整体分，而是逐条判断冻结 criterion。例如当前态题通常包含一条“是否说出正确值”的 memory-presence criterion，以及一条“是否避免把兄弟状态说成当前值”的 forgetting-absence criterion。两位交叉 Reader/Judge cell 在 case-arm 层取算术平均。

### 7.4 指标定义

| 指标 | 定义 | 用途 |
|---|---|---|
| criterion accuracy | 正确 criterion 数 / 全部 criterion 数 | 70 题能力面板主指标 |
| MPA | memory-presence criterion 的正确比例 | 是否使用了应出现的记忆 |
| FAA | forgetting-absence criterion 的正确比例 | 是否避开不应出现或已失效状态 |
| FAMA | `max(0, MPA - λ × (1 - FAA))`，λ 为 absence criterion 占比 | 同时惩罚遗漏与错误保留 |
| 期望集合精确率 | 实际召回 ID 集合与期望集合完全相同的 case 比例 | 检查回答前的状态选择 |
| 期望状态召回率 | 召回到的期望状态数 / 期望状态总数 | 检查是否漏掉必要状态 |
| 污染率 | 含任一非期望状态的 case 比例 | 检查跨域污染 |
| token / 条目 / 延迟 | 最终注入提示的 token、ID 数和本地召回耗时 | 工程成本与上下文预算 |

主比较使用 5,000 次配对聚类 bootstrap，能力题按 10 个场景聚类，安全题按 10 个 persona 聚类，报告 95% 区间。Reader 方向、逐题改善/持平/受损、完整性和 token 预算作为稳健性检查。评分前代码固定在 `4d77e698…`，上下文 SHA-256 为 `2c64c12…a1960f`。

## 8. 实验结果与提升幅度

### 8.1 70 题能力面板

| 指标 | 全局混合 | 线性新旧双态 | 版本感知多状态 |
|---|---:|---:|---:|
| criterion accuracy | 94.29% | 67.50% | **100.00%** |
| MPA | 94.29% | 47.14% | **100.00%** |
| FAA | 94.29% | 87.86% | **100.00%** |
| FAMA | 94.29% | 47.14% | **100.00%** |
| 期望集合精确率 | 0.00% | 0.00% | **100.00%** |
| 期望状态召回率 | 85.71% | 21.43% | **100.00%** |
| 跨状态污染率 | 100.00% | 100.00% | **0.00%** |
| 平均注入 token | 557.89 | 487.57 | **395.90** |
| 平均召回条目 | 4.00 | 2.03 | **1.29** |
| 本地平均召回耗时 | 0.622 ms | 0.822 ms | **0.569 ms** |

答案主指标相对全局混合提升 5.71 点，95% 区间 [2.86, 8.57]；相对线性双态提升 32.50 点，区间 [30.36, 34.64]。能力面板 token 相比分别减少 29.04% 和 18.80%，召回条目分别减少 67.86% 和 36.62%。本地平均耗时相比分别下降 8.52% 和 30.78%，但这是 SQLite 微基准，不代表远端 TCVDB/COS 延迟。

### 8.2 各能力点

| 能力点 | 全局混合 | 线性双态 | 新方案 | 新方案提升（对前两组） |
|---|---:|---:|---:|---:|
| 分支当前态 | 100.00% | 42.50% | **100.00%** | +0.00 / +57.50 点 |
| worktree 当前态 | 100.00% | 50.00% | **100.00%** | +0.00 / +50.00 点 |
| 并行任务当前态 | 100.00% | 50.00% | **100.00%** | +0.00 / +50.00 点 |
| 分支比较 | 100.00% | 100.00% | **100.00%** | +0.00 / +0.00 点 |
| 迁移 | 100.00% | 100.00% | **100.00%** | +0.00 / +0.00 点 |
| 回归 | 100.00% | 100.00% | **100.00%** | +0.00 / +0.00 点 |
| 缺失 scope 弃权 | 60.00% | 30.00% | **100.00%** | +40.00 / +70.00 点 |

相对全局混合召回，70 题中 7 题改善、63 题持平、0 题受损；两位 Reader 的方向分别为 +2.86 和 +8.57 点。相对线性新旧双态，40 题改善、30 题持平、0 题受损；两位 Reader 分别为 +27.86 和 +37.14 点。

分支比较、迁移、回归没有额外答案涨幅，但上下文机制不同：全局基线把无关 worktree/task 一并交给模型；新方案只保留完成该问题所需的分支状态并标注来源。这个结果表明，答案满分不等于召回集合正确，必须同时报告答案层和上下文层指标。

### 8.3 40 题 Memora 安全面板

三组提示和答案完全相同，criterion accuracy 均为 8.49%，FAMA 均为 **2.19%**，差值 0.00 点，40 题全部持平。这个绝对值较低，说明所冻结的少量召回上下文本身不足；它只能证明版本逻辑没有改变 legacy unscoped 路径，不能用来宣称通用长期记忆质量提升。

## 9. 实际使用优势

| 场景 | 线性或全局召回的问题 | 版本感知多状态的作用 |
|---|---|---|
| 长期维护分支 | release 修补被 main 的最新写入覆盖 | 两个分支同时有效，普通执行只取当前分支 |
| 多 worktree 开发 | 同分支不同本地实验相互污染 | worktree 哈希隔离未合并状态，比较时再联合 |
| 并行 Agent 任务 | 同会话最后写入任务覆盖其他任务假设 | `session + taskId` 延续各自上下文 |
| 迁移和回归分析 | 只保留“最新”会失去对照条件 | 返回有界、多来源、可追溯状态集合 |
| 上下文缺失 | 任意选择一个分支值并自信回答 | scoped 记忆弃权，避免无依据猜测 |
| 提示预算 | 让模型阅读所有相关但无效状态 | 先做确定性有效域过滤，再占用 token |

## 10. 已证明范围与局限

本次已经证明：真实 Git/worktree 探测、隐私化坐标、同会话并行 task 延续、真实 SQLite 写入、同域去重、最终生产召回、当前态与多状态选择、提示标签、双 Reader/交叉 Judge、legacy 向后兼容和独立复算能够按冻结协议完成。独立验证从 500 条原始 verdict 重算所有答案指标、上下文指标、bootstrap、门槛与哈希，结果为 `passed`，`mismatchCount = 0`。

本次没有证明：自动 LLM 抽取总能选对 `scopeLevel`；在线 TCVDB/COS 网络延迟；复杂 merge ancestry、cherry-pick 和分支重命名推理；无控制真实编程流量中状态冲突的发生率；人类裁判与模型 Judge 的一致性。公开 Memora 安全面板也不是新留出集。上述边界决定了本报告支持的是“版本作用域机制及其生产召回路径有效”，而不是“所有长期记忆任务都会获得相同幅度提升”。

证据文件：

- `results/version-aware-final/context/context-manifest.json`
- `results/version-aware-final/e2e/evaluations.jsonl`
- `results/version-aware-final/e2e/summary.json`
- `results/version-aware-final/e2e/independent-validation.json`

审计哈希：上下文 `2c64c12d…a1960f`；原始评测 `e546f4f9…65ee61`；汇总 `fbe7d455…e61`；独立复算 `758cade8…678`。
