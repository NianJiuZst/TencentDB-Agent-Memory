# 30 个真实任务的 MiniMax 成对评测

当前主评测是 **30 个任务 × 无记忆/最终优化方案 × 各一次，共 60 次执行**，模型固定为 MiniMax-M3。任务使用真实公开仓库、实际 mini-swe-agent 和独立官方测试容器。DeepSeek、额外重复、中间策略、Pro 与历史版本扩展均已暂停，旧材料单独保留，不混入主分数。

## 当前协议与材料

- `pilot-protocol.json`：精简协议、模型与相同运行限制。
- `pilot-registration.json`：新增调用前登记；如实注明发生在早期广面板调用之后。
- `submission/evidence/agent-e2e/pilot-candidate-order.json`：244 个候选的固定顺序，保留最初 100 个候选前缀。
- `pilot-30-160/selection.json`：按该顺序选择的前 30 个参考预检合格任务，同一修复 PR 只取一个。
- `pilot-30-160/references/`：只读取参考验证信息的纳入/排除决定，不访问 Agent 成败。
- `pilot-30-160/pairs/`：每个任务两组结果，及其登记、输入和评分摘要。
- `pilot-30-160/runs/`：60 次新执行的真实轨迹、补丁和独立测试。
- `pilot-30-160/analysis.json`：独立复算、成对改善/退化、bootstrap 区间、精确 McNemar 检验、费用和记忆覆盖。

两组使用同一初始提交、工具和限制：160 步、步骤边界检查的 1,800 秒预算、每次输出 8,192 tokens、温度 0.2、adaptive thinking、1.5 CPU、2 GiB 内存。模型未提交补丁时计为预算内失败。60 次均是分别执行，不因上下文相同而共用结果。用户在观察到旧上限导致多次未完成后授权统一提高限制。全部 60 次重新执行；旧 80 步模型结果保留在 `pilot-30/` 和 `formal/`，不进入新主结论。已完成的参考环境验证和未改变的记忆输入可以复用。

成功要求所有指定修复测试与回归测试通过。先验证有缺陷版本确实触发修复测试失败、回归测试通过，再确认参考补丁使全部测试通过。缺失、跳过、超时与环境异常不能算通过。纯镜像下载故障可重试同一内容，所有尝试保留。

按用户后续要求，报告增加适合作业展示的分层评价，见 `reporting-rubric.json`：工程功能与回归检查、目标缺陷修复、部分修复、按任务等权的平均目标完成度，以及完整过关。新增指标是在执行开始后补充的描述性分析，不改变任务选择或原始完整成功口径。原有测试保持通过不算修复进展；目标修复与引入回归分开呈现，所有正负结果保留。

## 只复算已保存结果（不调用模型）

从仓库根目录执行；运行目录需要固定的公开数据与框架：

```sh
TDAI_RUN_ROOT=/tmp/tdai-real-agent
"$TDAI_RUN_ROOT/venv/bin/python" MemoryCore/benchmarks/agent-e2e/analyze_pilot.py \
  --runtime "$TDAI_RUN_ROOT" \
  --evidence submission/evidence/agent-e2e \
  --ledger "$TDAI_RUN_ROOT/budget.sqlite"
"$TDAI_RUN_ROOT/venv/bin/python" -m unittest discover \
  -s MemoryCore/benchmarks/agent-e2e -p 'test_*.py' -v
```

复算逐例检查真实响应模型、初始 Git 提交、输入/补丁/轨迹摘要、修复与回归测试状态和价格计算。只有 30 对齐全、60 次检查通过，报告生成器才允许输出最终 PDF。

`finalize_pilot.py` 可在全部结果完成后执行独立复核、事务性费用快照、逐任务 CSV、凭证检查和 PDF 渲染；它不调用模型。生成的 PDF 仍须逐页视觉复核后交付。

## 从头复现

本次实测环境为 macOS arm64、Node 26、Python 3.12、Docker/Colima，amd64 镜像通过仿真运行。该执行入口的磁盘检查使用 Colima；Linux 原生移植尚未实测。报告不把本机耗时当作生产性能基准。

```sh
python3.12 MemoryCore/benchmarks/agent-e2e/bootstrap.py --runtime "$TDAI_RUN_ROOT"
```

该步骤使用 Python 3.12 创建环境，下载固定提交、验证公开数据摘要，并从源数据重建全部 244 个候选及原 100 个候选前缀，不调用模型。macOS arm64 上还下载并校验 regctl v0.11.5，用于 Docker 下载失败时恢复完全相同的官方镜像。旧实现固定为 `25a025b4be83dbc28877d8a740bd7a089a7297e5`，需独立检出并安装与当前分支相同的 Node 依赖。不要在正在运行实验的目录执行初始化；它会重新写出公开数据缓存。

换机器时，先复算提交结果，再为**新的结果目录**重绑定本机路径；此操作验证每份生产源码的字节摘要，并保留原始登记：

```sh
python3 MemoryCore/benchmarks/agent-e2e/relocate_pilot.py \
  --previous-core /absolute/path/to/baseline/MemoryCore \
  --backup-directory "$TDAI_RUN_ROOT/registration-backup"
```

Requests 需要真实 TCP 超时地址。本次使用内部网络，未修改测试或伪造异常：

```sh
docker network create --internal --subnet 10.255.255.0/24 \
  --gateway 10.255.255.254 --aux-address tarpit=10.255.255.1 tdai-benchmark-20260905
```

新评测目录只复制固定候选清单，不覆盖已提交结果：

```sh
mkdir -p "$TDAI_RUN_ROOT/fresh-evidence"
cp submission/evidence/agent-e2e/pilot-candidate-order.json "$TDAI_RUN_ROOT/fresh-evidence/"
```

以下命令会调用付费模型。凭证只通过 `MINIMAX_API_KEY` 环境变量提供，不挂载到容器，也不写入配置。预算按 `budget-authorization.json` 和共享 SQLite 账本执行；当前授权总额 1,000 元，其中本轮上限 990 元、此前工作预留 10 元。

```sh
NO_PROXY=api.minimaxi.com no_proxy=api.minimaxi.com \
"$TDAI_RUN_ROOT/venv/bin/python" MemoryCore/benchmarks/agent-e2e/run_pilot.py \
  --runtime "$TDAI_RUN_ROOT" --evidence "$TDAI_RUN_ROOT/fresh-evidence" \
  --ledger "$TDAI_RUN_ROOT/fresh-budget.sqlite" \
  --previous-core /absolute/path/to/baseline/MemoryCore
```

调度器只按参考预检推进固定选择顺序。源码与协议摘要不匹配会停止；基础设施错误留下待处理任务，不能换成容易成功的题。已经完成的结果直接保留；中断且没有完整结果的执行不会静默重跑。

## 结论边界与旧协议

主结论定位为小规模真实任务验证：30 题每净成功一题相差 3.33 个百分点，差一两题不足以证明稳定提升。报告同时给出实际注入记忆的任务数；空上下文对之间的单次差异不能归因于记忆策略。

历史内容来自公开参考经验，并非自然生成的长期 Agent 记忆。同仓库历史补丁须已存在于初始代码；记录日期不等于独立核实的发布时间。目标答案、隐藏测试和 hints_text 不进入 Agent。所有容器禁止外网，不挂载宿主目录、凭证或 Docker socket。

早期评分器的镜像标签适配错误已修复，旧补丁重放、旧评分保留。最终汇总拒绝旧版或不可评分结果。费用分开报告已知用量计价和未知用量的保守预留，不能当作精确供应商账单。

原四组、三次重复协议及 Pro/版本扩展仍保留供审计，见 `README-broad-archived.md`、`protocol.json` 与 `registration.json`；它们不再是当前默认执行计划。自动清理辅助程序只处理本次已排除且超时遗留的临时验证容器，日志先归档，现有用户服务保持运行。
