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
    cover = f"新增小规模真实任务验证：MiniMax-M3 在 30 个任务中执行两种策略各一次，共 60 次。无记忆基线成功 {b['successes']}/30，优化版成功 {o['successes']}/30；{interval}。{conclusion}"
    exclusions = sum(r['status'] == 'reference_excluded' for r in d['referenceDispositions'])
    duplicates = sum(r['status'] == 'duplicate_repair_pr' for r in d['referenceDispositions'])
    labels = {'none': '无记忆基线', 'optimized': '最终优化方案'}
    rows = '\n'.join(f"| {labels[a]} | {d['arms'][a]['successes']}/30 | {100*d['arms'][a]['successRate']:.2f}% | {d['arms'][a]['regressionRuns']}/30 |" for a in labels)
    repos = '\n'.join(f"| {repo} | {s['tasks']} | {s['noneSuccesses']} | {s['optimizedSuccesses']} |" for repo, s in d['repositories'].items())
    costs = '\n'.join(f"| {labels[a]} | {d['arms'][a]['usage']['requests']} | {d['arms'][a]['usage']['knownUsageCny']:.2f} | {d['arms'][a]['usage']['unknownUsageUpperCny']:.2f} | {d['arms'][a]['meanAgentSeconds']:.1f} |" for a in labels)
    first = f'''## 7. 小规模真实编程验证：设计

### 7.1 从答案题走向仓库任务

核心问题是：相同任务、模型和运行限制下，加上最终记忆方案，完整编程任务是否更容易成功？mini-swe-agent 2.4.6 在真实公开仓库中读取源码、修改文件、执行命令并提交补丁；独立容器执行官方测试。模型自评、文本相似度和答案评分均不作为最终成功依据。

按用户确定的精简计划，只保留 30 个任务、两种策略、每组一次，共 60 次。模型固定为 MiniMax-M3，adaptive thinking，温度 0.2，单次输出上限 8,192 tokens。两组均为最多 160 步、1,800 秒，命令默认超时 60 秒。未完成提交记为预算内失败。上游在步骤边界检查时间，正在进行的请求和重试可能使实测耗时超出预算。

### 7.2 不根据成功与否挑题

候选来自固定版本 SWEContextBench。保持最初仓库轮询与 SHA256(20260905|任务 ID) 排序，延伸到全部 244 个 Python 候选。按顺序取参考预检合格的前 30 个任务，每个修复 PR 最多一个。选满前共记录 {exclusions} 个参考预检排除、{duplicates} 个重复修复 PR 跳过；最终覆盖 {len(d['repositories'])} 个仓库、30 个修复 PR。

预检要求有缺陷版本的所有指定修复测试失败、回归测试通过；参考补丁使两类测试全部通过。缺失、跳过、超时与环境错误不能证明合格。纯下载故障可重试同一官方镜像，原尝试保留。成功率分母为合格的 30 个任务，不把环境排除混成策略失败；这一严格口径不能与官方排行榜直接横比。

### 7.3 对照与信息隔离

无记忆组的持久记忆上下文为空；优化组经真实 writeMemory 写入 SQLite，再经 performAutoRecall 注入上下文，k=5、最多 12,000 字符、候选倍率 4。真实容器的仓库与提交坐标显式传入宿主。两组分别运行，即使某例最终上下文同为空也不共享执行。

本面板按统一新限制重新执行 60 次。此前 80 步、1,200 秒阶段多次触及上限，用户据此授权两组一起提高限制；该阶段结果单独归档，不计入主结论。参考环境检查与未改变的记忆输入仍可复用。DeepSeek、中间策略、额外重复、Pro 和版本扩展暂停并单独归档。精简协议是用户在早期广面板运行后提出的修订；新增调用前已提交规则和源码登记，不将修订时间写成所有调用之前。

目标答案、隐藏测试和 hints_text 不进入 Agent。历史经验来自公开参考记录，排除目标任务、目标 PR、相同答案补丁，以及记录日期非更早或时区不明的条目；同仓库历史补丁还必须已存在于初始代码。记录日期不等于独立核实的发布时间，经验也不是自然生成的 Agent 长期记忆。容器禁止外网，不挂载宿主目录、凭证或 Docker socket。
'''
    second = f'''## 8. 完整任务结果与配对结论

### 8.1 单次运行任务成功率

| 策略 | 成功任务 | 成功率 | 发生回归的运行 |
|---|---|---|---|
{rows}

每个成功任务均要求全部指定修复与回归测试通过。测试数量不是任务数量，也未从多次运行中挑选最好结果。全部 60 次的补丁摘要、实际模型、初始提交、测试状态与费用计算均已独立复核。真实任务框架另有 20 项本地检查通过，包括去除重复计数、严格评分、配对统计、费用恢复和拒绝旧限制结果。

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

本面板检验带公开历史参考经验的完整修复任务，没有自然运行多天并自动抽取、更新长期记忆，也没有重新运行已暂停的历史版本扩展。两组比较不能把任务差异单独归因于某个新增修复；优化来源由前文代码对照验证。候选保留、作用域隔离和快照身份修复，与本页任务成功率属于不同证据。召回修复成立，仍可能无法转化为最终成功数提升。

### 9.2 成本与耗时

| 策略 | API 请求 | 已知计价/元 | 未知上界/元 | 平均 Agent 秒 |
|---|---|---|---|---|
{costs}

本面板已知用量按公开标准价格计价 {d['usage']['pilotKnownUsageCny']:.2f} 元，未返回用量请求另保守计入上界 {d['usage']['pilotUnknownUsageUpperCny']:.2f} 元；不能混写为已知实际账单。仓库 Agent 评测含开发、已暂停面板和主评测合计保守记账 {d['usage']['allWorkChargedCny']:.2f} 元。前一轮答案评测采用另一种保守记账口径，两者不能直接相加作为实际账单。用户授权总额为 1,000 元，共享账本上限 990 元、此前工作预留 10 元。

Agent 耗时包含命令、模型和网络等待，不含镜像下载及参考预检，召回耗时另存逐例记录。amd64 镜像运行于 Apple Silicon 并共享本机资源。主评测最多两个任务工作线程，因此不把该时间当作生产性能基准。主评测绕过显式 HTTP 代理，系统路由仍可能经过网络隧道。

### 9.3 评分修复与材料核验

早期适配器将镜像摘要误作临时标签，导致测试启动失败。已改为合法标签并验证其内容等同于固定摘要；旧评分保留，已保存补丁重放，不新增模型调用。开发样本 131 项测试、Requests-3359 参考补丁 69 项测试通过适配器独立校验。主评测汇总拒绝旧评分和不可评分的环境异常。

分支提供协议、固定清单、逐例输入、真实轨迹、补丁、官方测试输出和独立复算程序。初次精简实现提交 8599a63、登记提交 8556d16；160 步修订的源码和登记摘要另存 pilot-registration.json，所有历史版本保留。复算入口 analyze_pilot.py，最终任务清单为 pilot-30-160/selection.json。报告只在 30 对结果齐全、60 次核验通过后生成。

公开来源：[SWEContextBench](https://github.com/jiayuanz3/SWEContextBench)、[mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent)、[MiniMax 价格](https://platform.minimaxi.com/docs/guides/pricing-paygo)。数据与框架提交在协议中记录；远程模型别名和价格可能随时间变化。
'''
    return {'cover': cover, 'conclusion': conclusion, 'pages': [first, second, third]}
