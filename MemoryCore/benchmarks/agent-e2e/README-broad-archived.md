# 真实编程 Agent 评测

本目录把实际 `writeMemory → SQLite FTS5 → performAutoRecall` 接到固定版本的
mini-swe-agent。Agent 在公开任务的 Docker 环境中读代码、执行命令并提交补丁；
独立容器用官方测试判定结果。没有用模型自评、答案匹配或模拟工具代替测试。

正式比较包含无持久记忆、全局记忆、旧实现（`25a025b`）和优化实现四组。
任务清单、模型、预算、重复次数、数据排除规则与统计口径见 `protocol.json`。
`registration.json` 记录正式评分前的提交和源码摘要。

## 环境与输入

从仓库根目录使用 Python 3.12 下载固定源码、数据和依赖，随后验证任务清单：

```sh
TDAI_RUN_ROOT=/tmp/tdai-real-agent
python3 MemoryCore/benchmarks/agent-e2e/bootstrap.py --runtime "$TDAI_RUN_ROOT"
```

该步骤不调用模型。它检查 Parquet 摘要并重建两份清单，任何差异均停止执行。
旧版 MemoryCore 需检出协议中的 `25a025b`，并安装与本分支相同的 Node 依赖。
换机器复现时，摘要保持不变，只重绑定登记文件中的本地目录：

```sh
python3 MemoryCore/benchmarks/agent-e2e/relocate_registration.py \
  --previous-core /absolute/path/to/baseline/MemoryCore \
  --backup-directory "$TDAI_RUN_ROOT/registration-backup"
```

- 本次使用 Python 3.12、Node 26、Docker/Colima（amd64 镜像运行于 Apple Silicon）。
- 外部代码固定为协议中列出的 SWEContextBench、SWE-bench Pro、mini-swe-agent 提交。
- Python 包快照位于 `submission/evidence/agent-e2e/python-environment.txt`。
- 模型凭证只读取 `DEEPSEEK_API_KEY` / `MINIMAX_API_KEY` 环境变量，不传入容器或保存至配置。
- 设置独立运行目录，例如 `TDAI_RUN_ROOT=/tmp/tdai-real-agent`。其中放置三个固定源码仓库、
  Python 虚拟环境 `venv`、固定版本的公开 Parquet 文件及预算账本。该目录不是提交材料。
- `prepare_dataset.py` 解析五个 SWEContextBench 表并固定任务清单；`audit_data.py`
  记录重复、时区、PR/补丁重合及两种数据发布格式之间的差异。
- 官方任务 JSON 用于可执行评分；目标的答案、隐藏测试和 `hints_text` 不进入 Agent 输入。

Requests 的测试要求 `10.255.255.1` 是不响应连接的地址。本次通过真实内部网络提供该条件，
不修改测试或伪造异常：

```sh
docker network create --internal --subnet 10.255.255.0/24 \
  --gateway 10.255.255.254 --aux-address tarpit=10.255.255.1 \
  tdai-benchmark-20260905
```

保留原有容器；只创建本次任务的临时容器和镜像。Agent 不挂载宿主目录、凭证或 Docker socket。
Pro 的 Agent 环境仅保留初始提交的浅克隆，原镜像中的未来修复提交只对独立评分器可见。

## 执行顺序

1. 下载固定数据和官方镜像，运行 `preflight_batch.py`（主基准）或
   `pro_score.py --reference`（Pro）。参考补丁必须使所有修复与回归测试通过。
   初始回归失败、缺失、跳过、超时或参考补丁无效的任务单独记录。
2. 用 `freeze_task.py` 或 `freeze_pro_task.py` 固定四组上下文与完整输入。
   主基准的历史同仓库补丁还必须能在初始代码上反向检查成功。
   没有明确时区的经验记录不假定为过去。版本扩展读取真实初始源码和祖先提交，单独报告。
3. 提交协议、清单及实验代码，再生成并提交 `registration.json`。正式执行器会检查摘要。
4. 用 `run_cohort.py` 调用 `run_task_matrix.py`，每个任务/模型/组重复三次。
   严格相同的完整输入可在同一任务、模型、重复编号内共享执行；不同重复间不复用。
5. 保存轨迹、补丁、官方测试输出、测试状态和预算账本。预算不足或基础设施错误会留下未完成状态，
   不会自动改成成功，也不会把环境排除计作策略失败。

例如，在仓库根目录运行单个已固定任务的全部对照：

```sh
"$TDAI_RUN_ROOT/venv/bin/python" MemoryCore/benchmarks/agent-e2e/run_task_matrix.py \
  --runtime "$TDAI_RUN_ROOT" \
  --frozen /absolute/path/to/frozen/task \
  --preflight /absolute/path/to/preflight.json \
  --output /absolute/path/to/results/task \
  --ledger "$TDAI_RUN_ROOT/budget.sqlite" \
  --model deepseek-v4-flash
```

本地协议检查：

```sh
"$TDAI_RUN_ROOT/venv/bin/python" -m unittest discover \
  -s MemoryCore/benchmarks/agent-e2e -p test_protocol.py -v
```

## 结论边界

`analyze_results.py` 仅汇总完整的 12 个组别记录，并检查输入、补丁与评分摘要。
它按修复 PR 聚类计算区间，分别统计名义记录、独立执行与实际 API 请求。
预算账本包含没有返回用量的失败请求预留；它们单列为保守上界，不能当作实际账单。
源码初始观察与召回耗时单独记录。Docker 镜像下载和参考预检不属于 Agent 推理耗时。

```sh
"$TDAI_RUN_ROOT/venv/bin/python" MemoryCore/benchmarks/agent-e2e/analyze_results.py \
  --evidence submission/evidence/agent-e2e \
  --ledger "$TDAI_RUN_ROOT/budget.sqlite" \
  --output submission/evidence/agent-e2e/analysis.json
```

`dataset-audit.json` 中 `eligible_past_experiences` 是最初的候选数量，尚未应用全部
时间、PR、补丁与祖先检查，不能作为实际召回覆盖率。实际准入见每例 `history-audit.json`。
`quality-audit.json` 的时间顺序初筛使用原始字符串；UTC 语义复算另存
`temporal-audit.json`（91 条明确更早、174 条不早于目标、111 条时区不明的关系）。
真正的记忆准入始终调用 `aware_timestamp`，不采用该字符串初筛。

初期两个完整任务使用继承代理；后续新任务使用国内模型接口的直接 HTTPS。
任务分组和原因在 `transport-cohorts.json`，全部初期结果保留，汇总同时提供去掉
初期传输组的敏感性结果。可在启动新任务时设置 `NO_PROXY` 和 `no_proxy` 为
`api.deepseek.com,api.minimaxi.com`；不要在同一任务的四组之间改变传输路径。
1,200 秒是上游 Agent 在步骤边界检查的时间预算，正在进行的请求与重试可能导致超出，
每次实际耗时均保存。上游默认最多重试 10 次，单次请求超时 180 秒。

主指标是独立测试判定的完整任务成功率。测试数量和重复执行次数不充当独立任务样本；
同一修复 PR 的不同问题描述一起参与聚类置信区间计算。

历史经验来自公开参考记录，版本扩展来自真实源码观察。本轮没有把它们声称为模型自动抽取的长期记忆，
也不测云端存储延迟。公开基准、版本扩展、开发试跑分别计分。参考排除及失败结果保留在证据中。
