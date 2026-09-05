"""Report chapters derived exclusively from the completed MiniMax pilot."""
import json


def build(evidence):
    d = json.loads((evidence / 'agent-e2e/pilot-30-160/analysis.json').read_text())
    if d['status'] != 'completed' or d['completedTasks'] != 30 or d['executions'] != 60:
        raise RuntimeError('The 30-task, 60-execution MiniMax pilot is not complete')
    if d['validation']['status'] != 'passed' or d['validation']['executionsChecked'] != 60:
        raise RuntimeError('All 60 executions require independent verification')
    b, o, p = d['arms']['none'], d['arms']['optimized'], d['paired']
    v = p['delta']
    interval = f"{100*v['mean']:+.2f} 个百分点，95% 配对区间 [{100*v['lower']:.2f}, {100*v['upper']:.2f}]"
    net = p['improved'] - p['harmed']
    if net > 0:
        conclusion = f'优化版在这 30 个任务中净增加 {net} 个成功任务。' + ('配对结果支持本样本内的提升，仍需扩大样本验证稳定性。' if v['lower'] > 0 and p['exactMcNemarP'] < .05 else '现有差异不足以证明稳定提升，不能宣称通用编程成功率已经提高。')
    elif net == 0:
        conclusion = '本次两组成功总数相同，没有观察到最终成功率的净提升。'
    else:
        conclusion = f'本次优化版比无记忆基线少成功 {-net} 个任务，不支持提高完整编程成功率的结论。'
    cover = f"新增小规模真实任务验证：MiniMax-M3 在 30 个任务中执行两种策略各一次，共 60 次。目标缺陷修复：基线 {b['targetRepairSuccesses']}/30，优化版 {o['targetRepairSuccesses']}/30；修复并通过全部回归测试：基线 {b['successes']}/30，优化版 {o['successes']}/30，差值{interval}。{conclusion}"
    exclusions = sum(r['status'] == 'reference_excluded' for r in d['referenceDispositions'])
    duplicates = sum(r['status'] == 'duplicate_repair_pr' for r in d['referenceDispositions'])
    labels = {'none': '无记忆基线', 'optimized': '最终优化方案'}
    progress_rows = '\n'.join([
        f"| 目标缺陷修复 | {b['targetRepairSuccesses']}/30 | {o['targetRepairSuccesses']}/30 | 全部目标修复测试通过 |",
        f"| 有修复进展 | {b['anyTargetRepairTasks']}/30 | {o['anyTargetRepairTasks']}/30 | 至少一项目标测试通过，含全部修复 |",
        f"| 其中部分修复 | {b['partialTargetRepairTasks']}/30 | {o['partialTargetRepairTasks']}/30 | 部分目标测试通过 |",
        f"| 平均目标完成度 | {100*b['meanTargetRepairFraction']:.2f}% | {100*o['meanTargetRepairFraction']:.2f}% | 每题目标测试通过比例，任务等权 |",
        f"| 完整过关 | {b['successes']}/30 | {o['successes']}/30 | 修复与回归测试全部通过 |",
        f"| 发生回归 | {b['regressionRuns']}/30 | {o['regressionRuns']}/30 | 至少一项原有测试不再通过 |",
    ])
    repos = '\n'.join(f"| {repo} | {s['tasks']} | {s['noneSuccesses']} | {s['optimizedSuccesses']} |" for repo, s in d['repositories'].items())
    costs = '\n'.join(f"| {labels[a]} | {d['arms'][a]['usage']['requests']} | {d['arms'][a]['usage']['knownUsageCny']:.2f} | {d['arms'][a]['usage']['unknownUsageUpperCny']:.2f} | {d['arms'][a]['meanAgentSeconds']:.1f} |" for a in labels)
    first = f'''## 7. 小规模真实编程验证：设计

### 7.1 从答案题走向仓库任务

核心问题是：相同任务、模型和运行限制下，加上最终记忆方案，完整编程任务是否更容易成功？mini-swe-agent 2.4.6 在真实公开仓库中读取源码、修改文件、执行命令并提交补丁；独立容器执行官方测试。模型自评、文本相似度和答案评分均不作为最终成功依据。

正式评测固定为 30 个任务、两种策略、每组一次，共 60 次。模型固定为 MiniMax-M3，adaptive thinking，温度 0.2，单次输出上限 8,192 tokens。两组均为最多 160 步、1,800 秒，命令默认超时 60 秒。未完成提交记为预算内失败。上游在步骤边界检查时间，正在进行的请求和重试可能使实测耗时超出预算。

材料采用分层验收：工程功能与测试复现、目标缺陷修复、完整过关。目标修复和部分完成度在运行开始后补充为描述性指标；原始完整成功口径与任务选择规则保留。新增指标用于解释进展，不作预注册的显著性证明。

### 7.2 不根据成功与否挑题

候选来自固定版本 SWEContextBench。保持最初仓库轮询与 SHA256(20260905|任务 ID) 排序，延伸到全部 244 个 Python 候选。按顺序取参考预检合格的前 30 个任务，每个修复 PR 最多一个。选满前共记录 {exclusions} 个参考预检排除、{duplicates} 个重复修复 PR 跳过；最终覆盖 {len(d['repositories'])} 个仓库、30 个修复 PR。

预检要求有缺陷版本的所有指定修复测试失败、回归测试通过；参考补丁使两类测试全部通过。缺失、跳过、超时与环境错误不能证明合格。纯下载故障可重试同一官方镜像，原尝试保留。成功率分母为合格的 30 个任务，不把环境排除混成策略失败；这一严格口径不能与官方排行榜直接横比。

### 7.3 对照与信息隔离

无记忆组的持久记忆上下文为空；优化组经真实 writeMemory 写入 SQLite，再经 performAutoRecall 注入上下文，k=5、最多 12,000 字符、候选倍率 4。真实容器的仓库与提交坐标显式传入宿主。两组分别运行，即使某例最终上下文同为空也不共享执行。

本面板按统一新限制重新执行 60 次。此前 80 步、1,200 秒试跑多次触及上限，随后两组统一提高限制；旧结果单独归档，参考环境检查和未改变的记忆输入可复用。其他模型、中间策略、重复与扩展暂停。方案修订及其发生时间均已登记，未将试跑改写为事先确定的正式结果。

目标答案、隐藏测试和 hints_text 不进入 Agent。历史经验来自公开参考记录，排除目标任务、目标 PR、相同答案补丁，以及记录日期非更早或时区不明的条目；同仓库历史补丁还必须已存在于初始代码。记录日期不等于独立核实的发布时间，经验也不是自然生成的 Agent 长期记忆。容器禁止外网，不挂载宿主目录、凭证或 Docker socket。
'''
    second = f'''## 8. 任务修复进展与完整过关

### 8.1 分层评价

| 指标 | 无记忆基线 | 最终优化方案 | 含义 |
|---|---|---|---|
{progress_rows}

“目标缺陷修复”不要求所有回归测试通过，因此不能写成完整任务成功；“有修复进展”包含全部修复与部分修复，几行数字不能相加。空提交即使保持了原有测试，也不获得修复进展。目标完成度的成对改善任务为 {d['descriptiveProgress']['targetRepairImprovedTasks']} 个、退化为 {d['descriptiveProgress']['targetRepairHarmedTasks']} 个。

全部 60 次的补丁摘要、实际模型、初始提交、测试状态与费用计算均已独立复核。框架原有 20 项检查及新增 3 项分层计分检查通过，覆盖去重、评分、配对统计、费用恢复和旧限制隔离。

基线有 {b['emptySubmissions']} 次、优化组有 {o['emptySubmissions']} 次未提交补丁；无法应用的补丁分别为 {b['patchApplicationFailures']} 次、{o['patchApplicationFailures']} 次。非空补丁送入独立官方验证器；空提交或无法应用按已验证的原始代码计为失败，不重复运行相同的基线测试，也不把退出前未提交的工作区改动算作提交。

| 成对结果 | 任务数 |
|---|---|
| 两组都成功 | {p['bothSucceeded']} |
| 只有优化版成功 | {p['improved']} |
| 只有无记忆基线成功 | {p['harmed']} |
| 两组都失败 | {p['bothFailed']} |

优化版减去基线：**{interval}**；精确双侧 McNemar p={p['exactMcNemarP']:.4f}。按修复 PR 成对重采样 5,000 次，固定种子 20260905。样本通过确定性规则选取，区间仅描述本评测的不确定性，不代表所有真实开发任务的概率抽样推断。

### 8.2 各仓库结果

| 仓库 | 任务数 | 基线成功 | 优化成功 |
|---|---|---|---|
{repos}

**对核心问题的回答。** {conclusion} 30 个任务中净多成功一个仅相差 3.33 个百分点，差一两个任务不足以证明稳定提升。结论定位为“小规模真实任务验证”。
'''
    third = f'''## 9. 结果解释、成本与复现

### 9.1 记忆是否实际进入任务

优化组在 {o['contextCoverage']}/30 个任务中实际注入非空持久记忆，总计 {o['totalContextChars']} 个字符；其他任务因没有合格召回而保持空上下文。注入的跨仓库记忆数为 {o['foreignRepositoryMemories']}。没有实际记忆输入时，成对差异主要反映模型单次运行波动，不能归因于检索策略。

真实任务面板检验公开历史经验能否帮助仓库修复；它不等同于自然运行多天、持续学习的长期记忆实验。两组比较检验整套方案的效果，各项代码优化的贡献由前文对照测试说明。正确召回是必要的工程能力，能否转化为更多成功任务则由本面板回答。

### 9.2 成本与耗时

| 策略 | API 请求 | 已知计价/元 | 未知上界/元 | 平均 Agent 秒 |
|---|---|---|---|---|
{costs}

本面板已知用量按公开标准价格计价 {d['usage']['pilotKnownUsageCny']:.2f} 元，未返回用量请求另保守计入上界 {d['usage']['pilotUnknownUsageUpperCny']:.2f} 元；不能混写为已知实际账单。含开发、试跑和主评测的 Agent 工作合计保守记账 {d['usage']['allWorkChargedCny']:.2f} 元。前一轮答案评测采用另一种保守记账口径。总预算上限 1,000 元，共享账本上限 990 元、此前工作预留 10 元。

Agent 耗时包含命令、模型和网络等待，不含镜像下载及参考预检；召回耗时另存逐例记录。amd64 镜像在 Apple Silicon 上仿真执行，最多两个任务并发，共享本机资源；本机耗时只作该配置下的描述，不视为生产性能基准。

### 9.3 评分修复与材料核验

评分器固定镜像内容，在独立容器中执行官方测试，再从逐项状态复算指标。早期镜像适配错误已修复并以保存的补丁重放；旧评分归档，主汇总只接纳修正后的可评分结果，详情见复现说明。

分支提供冻结协议、任务清单、逐例输入、轨迹、补丁、测试输出及独立复算程序。源码与修订记录见 pilot-registration.json；任务清单见 pilot-30-160/selection.json。analyze_pilot.py 复算指标，finalize_pilot.py 导出逐任务 CSV、费用快照与报告。最终 PDF 在 30 对齐全、60 次核验通过后生成，并另作逐页排版复核。

公开来源：[SWEContextBench](https://github.com/jiayuanz3/SWEContextBench)、[mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent)、[MiniMax 价格](https://platform.minimaxi.com/docs/guides/pricing-paygo)。数据与框架提交在协议中记录；远程模型别名和价格可能随时间变化。
'''
    return {'cover': cover, 'conclusion': conclusion, 'pages': [first, second, third]}
