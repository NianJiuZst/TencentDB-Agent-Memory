"""Publication text derived only from complete real-agent evidence."""
from pathlib import Path
import json


def build(evidence):
    data = json.loads((evidence / 'agent-e2e/analysis.json').read_text())
    if data['status'] != 'completed':
        raise RuntimeError('The registered coding-agent evaluation is still incomplete')
    panels = data['panels']
    main = panels.get('main/deepseek-v4-flash')
    pro = panels.get('pro/deepseek-v4-flash')
    extension = panels.get('extension/deepseek-v4-flash')
    secondary = panels.get('main/MiniMax-M3')
    percent = lambda x: '—' if x is None else f'{100*x:.2f}%'
    number = lambda x: '—' if x is None else f'{x:.2f}'
    labels = {'none': '无持久记忆', 'global': '全局记忆', 'previous': '旧版严格筛选', 'optimized': '优化版严格筛选'}
    def cell(panel, arm):
        if not panel:
            return '无合格任务'
        v = panel['arms'][arm]
        return f"{percent(v['passAt1'])} ({v['successfulRuns']}/{v['nominalRuns']})"
    def interval(value):
        if value['mean'] is None:
            return '无可估计样本'
        return f"{100*value['mean']:+.2f} pp [{100*value['lower']:.2f}, {100*value['upper']:.2f}]"
    coverage = data['coverage']
    totals = {k: {name: v['counts'].get(name, 0) for name in ['eligible', 'excluded', 'pending']} for k, v in coverage.items()}
    if main:
        diff = main['comparisons']['optimized_vs_none']['passAt1Delta']
        conclusion = ('在该公开任务与固定 Agent 配置下，观察到完整任务成功率提高。'
                      if diff['lower'] > 0 and main['repairClusters'] >= 10 else
                      '目前不能宣称优化提高了通用编程任务的最终成功率。')
        cover = (f"新增真实编程评测：固定抽取 100 个 SWEContextBench 任务，{totals['main']['eligible']} 个通过严格参考预检；"
                 f"另抽取 20 个 SWE-bench Pro 任务，{totals['pro']['eligible']} 个合格。主面板中无记忆与优化版的平均 pass@1 分别为 "
                 f"{percent(main['arms']['none']['passAt1'])}、{percent(main['arms']['optimized']['passAt1'])}；配对差值 {interval(diff)}。{conclusion}")
    else:
        conclusion = '本机环境未提供足够的合格主任务，不能估计通用编程成功率增益。'
        cover = conclusion
    row_text = '\n'.join('| ' + labels[arm] + ' | ' + cell(main, arm) + ' | ' + cell(pro, arm) + ' | ' + cell(extension, arm) + ' |' for arm in labels)
    contrasts = []
    for name, panel in [('SWEContextBench', main), ('SWE-bench Pro', pro), ('真实历史版本扩展', extension)]:
        if not panel:
            continue
        for baseline in ['none', 'global', 'previous']:
            contrast = panel['comparisons']['optimized_vs_' + baseline]
            contrasts.append(f"| {name} / 对比{labels[baseline]} | {interval(contrast['passAt1Delta'])} | {contrast['improvedTasks']} / {contrast['tiedTasks']} / {contrast['harmedTasks']} |")
    independent = sum(v['independentExecutions'] for v in panels.values())
    nominal = sum(v['nominalAssignments'] for v in panels.values())
    first = f'''## 7. 真实编程评测：任务、环境与隔离

### 7.1 从答案题扩展到完整仓库任务

Agent 使用 mini-swe-agent 2.4.6，在真实仓库中检索源码、编辑文件、执行命令并提交补丁。独立容器运行官方测试，成功要求全部指定缺陷测试和回归测试通过。达到 80 步或步骤边界检测到 1,200 秒预算耗尽仍未提交，计为预算内任务失败。上游请求重试可能使实际耗时超出，网络等待包含在内。测试缺失、跳过、环境异常不能算通过；基础设施异常单独标记，不能用模型自评替代结果。

主面板固定抽取 100 个 SWEContextBench Python 任务，覆盖 88 个修复 PR；补充面板固定抽取 20 个 SWE-bench Pro 任务。任务按仓库轮询和固定哈希选取，在正式模型调用前提交。预检先在有缺陷版本上确认缺陷测试失败、回归测试通过，再确认参考补丁使全部指定测试通过。主面板合格 {totals['main']['eligible']}/100，排除 {totals['main']['excluded']}；Pro 合格 {totals['pro']['eligible']}/20，排除 {totals['pro']['excluded']}。所有排除及重试证据保留，结论只适用于合格子集。此严格定义不同于上游仅检查修复项的 resolved，不能直接与官方排行榜横比。

### 7.2 对照设计与真实记忆链路

四组共用同一任务、初始提交、模型参数和工具。全局组使用优化代码并关闭版本筛选；旧版组加载真实旧提交 25a025b；优化组加载本分支生产源码；无记忆组仅清空持久记忆上下文。历史记录经 writeMemory 写入 SQLite，再经 performAutoRecall 生成提示，k=5、最大 12,000 字符、候选倍率 4、状态上限 6、策略预算 100 ms。真实容器的仓库与提交坐标显式传给宿主，未把这次实验说成自动 Git 探测或自动事实抽取评测。

主模型为 deepseek-v4-flash，开启 thinking；另在固定前 20 个主任务的合格子集上运行 MiniMax-M3 adaptive thinking。温度 0.2，每次输出上限 8,192 tokens。每组重复三次，同一修复 PR 的任务变体共同参加 5,000 次配对 bootstrap。版本扩展与第二模型面板分别报告。模型配置仅在排除于正式样本的 Requests-5474 开发任务上确定。

### 7.3 防止答案和未来版本泄漏

目标参考补丁、隐藏测试、hints_text 不进入 Agent 输入。主面板的历史内容来自更早的公开参考经验，并排除目标 ID、目标 PR、相同答案补丁以及没有明确时区的记录；同仓库历史补丁还必须能在初始代码上反向检查成功。它是“参考经验导入”，不是自然产生的 Agent 长期记忆。Pro 与该经验库的仓库完全不重合，因此它主要检验无关记忆干扰与隔离。

所有 Agent 容器禁止外网、不挂载宿主目录、凭证或 Docker socket。Pro 原镜像含未来 Git 提交，启动时在隔离容器中重建只含初始提交的浅克隆。Requests 使用内部网络提供真实 TCP 超时地址；该设置未改写测试或伪造异常。amd64 镜像在 Apple Silicon 上运行，耗时包含仿真影响。
'''
    second = f'''## 8. 完整任务成功率与配对结论

### 8.1 主模型结果

| 记忆策略 | SWEContextBench | SWE-bench Pro | 历史版本扩展 |
|---|---|---|---|
{row_text}

括号表示三次重复中的成功次数 / 名义运行次数。主指标是每个任务三次独立运行的平均 pass@1，不是“三次中选一次最好结果”。四组输入完全相同时，只在同一任务、模型和重复编号内共享一次执行，记录复用来源；不同重复之间不复用。全部面板合计 {nominal} 个名义组别记录、{independent} 次独立 Agent 执行，不能将两者混写。

### 8.2 优化版与各基线的配对比较

| 面板与基线 | 差值及 95% 区间 | 改善 / 持平 / 退化任务 |
|---|---|---|
{chr(10).join(contrasts)}

pp 为百分点。区间按底层修复 PR 聚类，保留问题变体、三次重复和四组的配对关系。少于 10 个修复簇的面板仅作描述，单任务成功不能外推为通用增益。回归测试数不是独立任务数；各仓库结果以及每例改善、持平和退化明细均保存在 analysis.json。

**对课题的回答。** {conclusion} 召回层的确定性修复与受控题得分提高仍成立，但能否改善完整编程任务，必须由本页公开任务的配对结果支持，不能由前文压力测试推导。
'''
    secondary_rows = '\n'.join(f"| {labels[arm]} | {cell(secondary, arm)} |" for arm in labels)
    cost_rows = []
    for name, panel in [('主面板', main), ('Pro', pro), ('历史版本扩展', extension), ('第二模型', secondary)]:
        if panel:
            cost_rows.append(f"| {name} | {panel['independentExecutions']} | {panel['actualModelCny']:.2f} |")
    third = f'''## 9. 版本扩展、第二模型与成本

### 9.1 真实历史版本扩展的含义

版本扩展仅使用固定前 20 个主任务的合格子集。程序根据公开任务描述，确定性选择三个相关 Python 源文件，读取初始版本和最多五个不同祖先版本的真实代码片段。所选文件不来自参考答案或隐藏测试。所有组共享相同的初始源码观察预算，记忆分别带真实提交坐标。全局组可能召回过时片段，旧版可能因提前截断而漏掉当前片段，优化版选择当前有效状态。

这检验“恢复带有不同版本观察的工作区”能否改善真实任务，是公开任务之上的自定义扩展。它不是 SWEContextBench 官方分数，也不是通过自然交互自动学习长期记忆的证明。初始源码选择、历史提取耗时及最终上下文均可核验，不能只计模型推理而隐藏记忆准备过程。

### 9.2 第二模型复测

| 策略 | MiniMax-M3 平均 pass@1 |
|---|---|
{secondary_rows}

第二模型使用同一批预先选定任务中的合格项、同样的四组和三次重复，单独报告，不与主模型混合扩大样本量。

### 9.3 模型用量与成本

| 面板 | 独立 Agent 执行 | 模型费用估算 / 元 |
|---|---|---|
{chr(10).join(cost_rows)}

费用按供应商返回的输入、输出与缓存命中量，以及记录的标准公开价格核算；DeepSeek 采用高峰价。正式完成矩阵费用 {data['usage']['completeMatricesChargedCny']:.2f} 元，本轮含开发验证和其他已结算请求合计 {data['usage']['totalChargedCny']:.2f} 元。其中未返回用量的请求按预留保守计入，其上界单独保存在用量汇总中；不能视为已知实际消费。预算预留、已返回用量和实际请求分别保存；前一轮统一 100 元/百万 token 的预算上界不能与本页费用相加作为实际账单。

初期 Sphinx-2549 和 Pro Ansible 任务使用代理，后续完整任务固定直连国内模型接口；全部初期结果保留，并提供排除这两个传输组的敏感性结果，不能忽略网络稳定性对时间预算的影响。

API 价格、模型别名和远程服务可能变化；本次运行保存实际响应、参数和用量。公开镜像预检会触发上游已定义的依赖重建或环境修复。任务排除、仿真开销、记忆来源和有限的仓库覆盖共同限定本报告的外推范围。

数据与框架：[SWEContextBench](https://github.com/jiayuanz3/SWEContextBench)、[SWE-bench Pro](https://github.com/scaleapi/SWE-bench_Pro-os)、[mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent)。本实验源码冻结为 69b24f8，正式调用前的摘要登记为 37206f2；完整版本和数据修订见 protocol.json 与 registration.json。
'''
    return {'cover': cover, 'conclusion': conclusion, 'pages': [first, second, third]}
