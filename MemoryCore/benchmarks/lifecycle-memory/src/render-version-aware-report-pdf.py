#!/usr/bin/env python3
"""Render the dense three-page version-aware memory report in Songti."""

from __future__ import annotations

import argparse
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen.canvas import Canvas
from reportlab.platypus import (
    Flowable,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Table,
    TableStyle,
)


NAVY = colors.HexColor("#132A44")
TEAL = colors.HexColor("#007F7B")
PURPLE = colors.HexColor("#6251A2")
PALE_TEAL = colors.HexColor("#EAF7F5")
PALE_BLUE = colors.HexColor("#EDF3F8")
PALE_PURPLE = colors.HexColor("#F1EEFA")
INK = colors.HexColor("#1E2935")
MUTED = colors.HexColor("#526170")
LINE = colors.HexColor("#CBD5DF")
PASS = colors.HexColor("#23855B")
SONGTI_PATH = "/System/Library/Fonts/Supplemental/Songti.ttc"
BRANCH_URL = "https://github.com/NianJiuZst/TencentDB-Agent-Memory/tree/codex/version-aware-multistate-memory"
CODE_ROOT = "https://github.com/NianJiuZst/TencentDB-Agent-Memory/blob/codex/version-aware-multistate-memory/MemoryCore"


class ArchitectureFlow(Flowable):
    def __init__(self, width: float):
        super().__init__()
        self.width = width
        self.height = 61

    def draw(self) -> None:
        canvas = self.canv
        labels = [
            ("宿主上下文", "cwd · taskId"),
            ("隐私坐标", "repo · branch · wt"),
            ("同域写入", "dedup · update"),
            ("候选过取", "SQLite · FTS5"),
            ("有效域选择", "task → repo"),
            ("查询视图", "当前 / 多状态"),
        ]
        gap = 8
        box_width = (self.width - gap * (len(labels) - 1)) / len(labels)
        for index, (title, subtitle) in enumerate(labels):
            x = index * (box_width + gap)
            fill = PALE_TEAL if index in (1, 4) else (PALE_PURPLE if index == 5 else PALE_BLUE)
            stroke = TEAL if index in (1, 4) else (PURPLE if index == 5 else LINE)
            canvas.setFillColor(fill)
            canvas.setStrokeColor(stroke)
            canvas.roundRect(x, 7, box_width, 45, 5, fill=1, stroke=1)
            canvas.setFillColor(NAVY)
            canvas.setFont("Songti-Bold", 7.5)
            canvas.drawCentredString(x + box_width / 2, 34, title)
            canvas.setFillColor(MUTED)
            canvas.setFont("Songti", 6.0)
            canvas.drawCentredString(x + box_width / 2, 19, subtitle)
            if index < len(labels) - 1:
                arrow_x = x + box_width + 1
                canvas.setStrokeColor(TEAL)
                canvas.setFillColor(TEAL)
                canvas.line(arrow_x, 30, arrow_x + gap - 3, 30)
                canvas.line(arrow_x + gap - 6, 33, arrow_x + gap - 3, 30)
                canvas.line(arrow_x + gap - 6, 27, arrow_x + gap - 3, 30)


class NumberedCanvas(Canvas):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._saved_page_states: list[dict[str, object]] = []

    def showPage(self) -> None:
        self._saved_page_states.append(dict(self.__dict__))
        self._startPage()

    def save(self) -> None:
        page_count = len(self._saved_page_states)
        for state in self._saved_page_states:
            self.__dict__.update(state)
            self._draw_footer(page_count)
            super().showPage()
        super().save()

    def _draw_footer(self, page_count: int) -> None:
        self.saveState()
        page_width, _ = A4
        self.setStrokeColor(LINE)
        self.line(16 * mm, 12.5 * mm, page_width - 16 * mm, 12.5 * mm)
        self.setFont("Songti", 6.2)
        self.setFillColor(MUTED)
        self.drawString(16 * mm, 7.9 * mm, "TencentDB Agent Memory · 版本/分支感知多状态记忆")
        self.drawRightString(page_width - 16 * mm, 7.9 * mm, f"{self._pageNumber} / {page_count}")
        self.restoreState()


def register_fonts() -> None:
    pdfmetrics.registerFont(TTFont("Songti", SONGTI_PATH, subfontIndex=6))
    pdfmetrics.registerFont(TTFont("Songti-Bold", SONGTI_PATH, subfontIndex=1))
    pdfmetrics.registerFontFamily(
        "Songti",
        normal="Songti",
        bold="Songti-Bold",
        italic="Songti",
        boldItalic="Songti-Bold",
    )


def make_styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle(
            "TitleCN", parent=base["Title"], fontName="Songti-Bold", fontSize=20.5,
            leading=25, textColor=NAVY, alignment=TA_LEFT, spaceAfter=4,
        ),
        "subtitle": ParagraphStyle(
            "SubtitleCN", parent=base["Normal"], fontName="Songti", fontSize=8.1,
            leading=11, textColor=MUTED, spaceAfter=8,
        ),
        "h1": ParagraphStyle(
            "H1CN", parent=base["Heading1"], fontName="Songti-Bold", fontSize=12.8,
            leading=16.2, textColor=NAVY, spaceBefore=9, spaceAfter=5.5, keepWithNext=True,
        ),
        "h2": ParagraphStyle(
            "H2CN", parent=base["Heading2"], fontName="Songti-Bold", fontSize=10.3,
            leading=13.2, textColor=TEAL, spaceBefore=8, spaceAfter=4.5, keepWithNext=True,
        ),
        "body": ParagraphStyle(
            "BodyCN", parent=base["BodyText"], fontName="Songti", fontSize=9.0,
            leading=13.7, textColor=INK, alignment=TA_LEFT, wordWrap="CJK", spaceAfter=6.2,
        ),
        "small": ParagraphStyle(
            "SmallCN", parent=base["BodyText"], fontName="Songti", fontSize=7.35,
            leading=9.8, textColor=MUTED, wordWrap="CJK", spaceAfter=2,
        ),
        "table": ParagraphStyle(
            "TableCN", parent=base["BodyText"], fontName="Songti", fontSize=7.35,
            leading=9.4, textColor=INK, wordWrap="CJK",
        ),
        "table_small": ParagraphStyle(
            "TableSmallCN", parent=base["BodyText"], fontName="Songti", fontSize=6.85,
            leading=8.75, textColor=INK, wordWrap="CJK",
        ),
        "table_head": ParagraphStyle(
            "TableHeadCN", parent=base["BodyText"], fontName="Songti-Bold", fontSize=7.35,
            leading=9.4, textColor=colors.white, wordWrap="CJK", alignment=TA_CENTER,
        ),
        "table_head_small": ParagraphStyle(
            "TableHeadSmallCN", parent=base["BodyText"], fontName="Songti-Bold", fontSize=6.85,
            leading=8.75, textColor=colors.white, wordWrap="CJK", alignment=TA_CENTER,
        ),
        "code": ParagraphStyle(
            "CodeCN", parent=base["Code"], fontName="Songti", fontSize=7.15,
            leading=9.4, textColor=INK, backColor=PALE_BLUE, leftIndent=4, rightIndent=4,
            borderPadding=3, borderColor=LINE, borderWidth=0.5, wordWrap="CJK",
        ),
        "callout": ParagraphStyle(
            "CalloutCN", parent=base["BodyText"], fontName="Songti", fontSize=8.9,
            leading=13.2, textColor=NAVY, wordWrap="CJK",
        ),
        "metric_value": ParagraphStyle(
            "MetricValueCN", parent=base["BodyText"], fontName="Songti-Bold", fontSize=13.2,
            leading=15.2, textColor=TEAL, alignment=TA_CENTER,
        ),
        "metric_label": ParagraphStyle(
            "MetricLabelCN", parent=base["BodyText"], fontName="Songti", fontSize=6.8,
            leading=8.4, textColor=MUTED, alignment=TA_CENTER,
        ),
    }


def para(text: str, style: ParagraphStyle) -> Paragraph:
    return Paragraph(text, style)


def link(label: str, url: str) -> str:
    return f'<link href="{url}" color="#007F7B"><u>{label}</u></link>'


def styled_table(
    rows: list[list[str]],
    widths: list[float],
    styles: dict[str, ParagraphStyle],
    header: bool = True,
    padding: float = 2.7,
    small: bool = False,
) -> Table:
    data = []
    for row_index, row in enumerate(rows):
        if header and row_index == 0:
            style = styles["table_head_small" if small else "table_head"]
        else:
            style = styles["table_small" if small else "table"]
        data.append([para(value, style) for value in row])
    table = Table(data, colWidths=widths, repeatRows=1 if header else 0)
    commands = [
        ("GRID", (0, 0), (-1, -1), 0.35, LINE),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), padding),
        ("RIGHTPADDING", (0, 0), (-1, -1), padding),
        ("TOPPADDING", (0, 0), (-1, -1), padding),
        ("BOTTOMPADDING", (0, 0), (-1, -1), padding),
    ]
    if header:
        commands += [
            ("BACKGROUND", (0, 0), (-1, 0), NAVY),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F7F9FB")]),
        ]
    table.setStyle(TableStyle(commands))
    return table


def callout(text: str, width: float, styles: dict[str, ParagraphStyle], color=TEAL) -> Table:
    table = Table([[para(text, styles["callout"])]], colWidths=[width])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), PALE_TEAL if color == TEAL else PALE_PURPLE),
        ("BOX", (0, 0), (-1, -1), 0.8, color),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    return table


def metric_strip(width: float, styles: dict[str, ParagraphStyle]) -> Table:
    values = ["+5.71 点", "0% → 100%", "100% → 0%", "-29.04%", "-67.86%"]
    labels = ["答案准确率", "精确状态选择", "跨状态污染", "注入 token", "召回条目"]
    table = Table(
        [
            [para(value, styles["metric_value"]) for value in values],
            [para(label, styles["metric_label"]) for label in labels],
        ],
        colWidths=[width / 5] * 5,
    )
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), PALE_BLUE),
        ("BOX", (0, 0), (-1, -1), 0.5, LINE),
        ("INNERGRID", (0, 0), (-1, -1), 0.3, LINE),
        ("TOPPADDING", (0, 0), (-1, 0), 5),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 1),
        ("TOPPADDING", (0, 1), (-1, 1), 1),
        ("BOTTOMPADDING", (0, 1), (-1, 1), 4),
    ]))
    return table


def build_pdf(output: Path) -> None:
    register_fonts()
    styles = make_styles()
    output.parent.mkdir(parents=True, exist_ok=True)
    doc = SimpleDocTemplate(
        str(output), pagesize=A4, leftMargin=16 * mm, rightMargin=16 * mm,
        topMargin=12 * mm, bottomMargin=17 * mm,
        title="TencentDB Agent Memory 版本分支感知多状态记忆",
        author="TencentDB Agent Memory",
    )
    width = A4[0] - doc.leftMargin - doc.rightMargin

    scope_rows = [
        ["层级", "有效域键", "适用条件", "典型状态"],
        ["repository", "repo", "仓库相同", "项目级构建约定"],
        ["branch", "repo + branch", "再匹配分支", "release 测试命令"],
        ["worktree", "repo + branch + wt", "再匹配 worktree", "未提交配置、实验环境"],
        ["task", "repo + branch + wt + task", "再匹配 taskId", "并行任务假设、临时命令"],
    ]
    story: list[object] = [
        para("版本/分支感知的多状态记忆闭环", styles["title"]),
        para(
            "TencentDB Agent Memory 实现与真实评测　|　2026-08-31　|　分支 codex/version-aware-multistate-memory　|　评分前提交 4d77e69",
            styles["subtitle"],
        ),
        callout(
            "<b>技术结论：</b>相对原始 Agent Memory 全局混合召回，70 个冻结版本能力题的答案准确率由 <b>94.29%</b> 提升到 <b>100.00%</b>，提升 <b>5.71 点</b> [2.86, 8.57]；同时精确状态选择率 0% → 100%，跨状态污染率 100% → 0%，注入 token -29.04%，召回条目 -67.86%。7 题改善、63 持平、0 受损。",
            width,
            styles,
        ),
        metric_strip(width, styles),
        para(
            "原始方案 = 同一 performAutoRecall 生产路径中关闭版本感知、直接使用全局 Top-k 的 global_latest；不是手工 mock，也没有更换 Reader/Judge。",
            styles["small"],
        ),
        para("1　原理：同域更新，跨域并存", styles["h1"]),
        para(
            "线性“旧→新”只适用于同一有效域。main、release、多个 worktree 和并行 Agent task 可以互相矛盾但同时正确；不同域并列保存，查询时按当前环境或问题意图选择。repo/worktree 为不可逆哈希，不保存远端 URL 或本机路径；commit 用于溯源。",
            styles["body"],
        ),
        ArchitectureFlow(width),
        styled_table(scope_rows, [0.15 * width, 0.29 * width, 0.21 * width, 0.35 * width], styles, padding=3.0),
        para("为什么不能直接用“新记忆”全局覆盖“旧记忆”", styles["h2"]),
        para(
            "时间新旧不等于事实有效性。例如 main 已升级到 Java 21，而 release/1.x 仍要求 Java 17；main 上较新的写入不能删除 release/1.x 的状态。只有两个事实的有效域键完全相同时，系统才允许 update、merge、delete 或建立纠错边；跨分支、跨 worktree、跨 task 的状态均保留为并列真值。",
            styles["body"],
        ),
        para(
            "<b>具体例子：</b>Agent 在 main 提问“当前 Java 版本”时只得到 Java 21，在 release/1.x 提问时只得到 Java 17；提问“比较 main 与 release”时才同时得到两条带分支标签的状态。如果 main 后续升级到 Java 22，系统只在 main 域内更新 21，不影响 release/1.x 的 17。",
            styles["body"],
        ),
        callout(
            "<b>查询决策：</b>当前态问题只返回执行环境匹配的状态；比较、迁移、回归或历史问题才进入有界多状态模式，并标记 ACTIVE SCOPE / VERSION STATE。缺少仓库上下文时抑制 scoped 候选，只兼容 legacy unscoped，不猜当前值。",
            width,
            styles,
            color=PURPLE,
        ),
        para(
            "系统维护三条不变量：<b>状态身份不可丢失</b>，每条 scoped 记忆都可追溯到 repo/branch/worktree/task；<b>更新只在同域发生</b>，新时间戳不能跨域覆盖事实；<b>返回集合有界</b>，当前态优先最具体有效域，多状态查询也受 maxVersionStates 限制。",
            styles["body"],
        ),
        para(
            "选择器对普通问题先过滤当前坐标可用的候选，再按 task → worktree → branch → repository 的具体程度排序；有 scoped 命中时 legacy 不参与竞争。多状态问题限定在同一 repository，先为每个有效域保留一条，再按原检索顺序补齐，因此既保留多样性又不破坏相关性排序。",
            styles["body"],
        ),
        para("闭环怎么形成", styles["h2"]),
        para(
            "宿主传入 workspaceDir、稳定 taskId 或显式 versionContext；写入阶段把版本坐标固化进 L1 metadata，同域去重只处理完全相同的有效域。召回先从真实 SQLite/FTS5 检索池按 4 倍过取，再执行生命周期解析与版本选择，避免正确状态被其他分支挤出原始 Top-k。",
            styles["body"],
        ),
        para(
            "每次召回记录查询意图、候选数、被抑制条数、返回状态数、fallback、token 和延迟。反馈只用于调整候选倍率、最大状态数和意图规则，不会自动跨域改写事实；状态内容仍由明确写入或同域纠错更新，从机制上阻断反馈污染。",
            styles["body"],
        ),
        PageBreak(),
        para("2　TencentDB Agent Memory 接入与 GitHub 代码", styles["h1"]),
        callout(
            f"<b>Fork 分支：</b>{link('NianJiuZst/TencentDB-Agent-Memory · codex/version-aware-multistate-memory', BRANCH_URL)}",
            width,
            styles,
            color=PURPLE,
        ),
    ]

    code_rows = [
        ["环节", "GitHub 代码", "接入职责"],
        ["作用域与选择", link("version-scope.ts", f"{CODE_ROOT}/src/core/lifecycle/version-scope.ts"), "域键、有效性、意图、标签、多状态选择"],
        ["Git/worktree", link("git-context.ts", f"{CODE_ROOT}/src/core/lifecycle/git-context.ts"), "仓库/worktree 身份、detached HEAD、隐私哈希"],
        ["并行任务延续", link("version-context-store.ts", f"{CODE_ROOT}/src/core/lifecycle/version-context-store.ts"), "按 session + task 保存坐标"],
        ["最终生产召回", link("auto-recall.ts", f"{CODE_ROOT}/src/core/hooks/auto-recall.ts"), "过取、生命周期解析、版本筛选和提示标签"],
        ["同域写入", f"{link('l1-dedup.ts', f'{CODE_ROOT}/src/core/record/l1-dedup.ts')} · {link('l1-writer.ts', f'{CODE_ROOT}/src/core/record/l1-writer.ts')}", "只在完全相同有效域内更新和建边"],
    ]
    dataset_rows = [
        ["数据面板", "来源与规模", "用途与边界"],
        ["版本能力", "10 场景 × 7 类题 = 70 题", "验证 branch/worktree/task/比较/迁移/回归/缺失 scope；受控生成"],
        ["Memora 安全", "固定 a6493188…；10 persona × 4 = 40 题", "仅验证 legacy 不退化；复用公开面板，不是新留出集"],
        ["Memora 原始规模", "600 问题；27,614 session；24,856 memory unit", "activity/preference/goal 的 add/update/delete 与 no-memory"],
    ]
    story += [
        styled_table(code_rows, [0.18 * width, 0.30 * width, 0.52 * width], styles, padding=3.0),
        para("接入现有 Agent，不替换原有记忆链路", styles["h2"]),
        para(
            "开启 recall.lifecycle.versionAwareMode = strict 和 autoDetectGit 后，宿主只需把当前工作目录和并行任务标识传给原生产调用。performAutoRecall 优先使用显式 versionContext，否则从 workspaceDir 自动探测 Git；writeMemory 接收同一个 versionContext 并写入 L1 metadata。原有检索策略、生命周期解析、Reader 和提示注入接口保持不变。",
            styles["body"],
        ),
        para(
            "performAutoRecall({ ...baseRecallArgs, workspaceDir, taskId })<br/>"
            "writeMemory({ ...baseWriteArgs, versionContext: detectedContext })",
            styles["code"],
        ),
        para(
            "生产参数使用候选过取倍率 4、最多 6 个版本状态。普通当前态通常只注入 1 条；只有问题显式要求比较、迁移、回归或历史时才返回多状态。Git 探测失败走安全 fallback，不改变 legacy unscoped 行为。",
            styles["body"],
        ),
        para("运行时调用链", styles["h2"]),
        para(
            "<b>① 捕获：</b>插件入口按 workspaceDir 探测 repo、branch、commit 和 worktree，并把 taskId 作为并行任务维度；显式坐标优先于自动探测。<br/>"
            "<b>② 写入：</b>L0 抽取结果继承 session + task 对应的坐标，writeMemory 将其写入 metadata；l1-dedup 只比较同域候选。<br/>"
            "<b>③ 召回：</b>auto-recall 在现有检索之后执行生命周期解析与版本选择，再把带来源标签的结果写回原有 prependContext。",
            styles["body"],
        ),
        para(
            "<b>Git 坐标：</b>repositoryId 优先对规范化 remote 做 SHA-256 短哈希，无 remote 时使用 git common-dir；worktreeId 对真实顶层目录做同样哈希。detached HEAD 写成 detached@提交前缀，同时保存完整 commitSha。探测超时为 250 ms、缓存 2 秒，异常返回 undefined 而不是泄露路径或猜测身份。",
            styles["body"],
        ),
        para("3　数据集与实验方法", styles["h1"]),
        styled_table(dataset_rows, [0.18 * width, 0.36 * width, 0.46 * width], styles, padding=3.0, small=True),
        para("真实生产路径与公平对照", styles["h2"]),
        para(
            "实验冻结原始全局混合、线性新旧双态和版本感知多状态三组对照，110 题各跑 3 组。环境包含真实 Git 仓库的 main、release、两个 detached worktree 和两个并行 task；50 个真实 SQLite/FTS5 数据库共执行 260 次 writeMemory，最终答案上下文全部经过 performAutoRecall，共 330 次召回且 fallback 为 0。",
            styles["body"],
        ),
        para(
            "70 个能力题由 10 个独立编程场景分别生成 7 类查询，场景是 bootstrap 聚类单位。40 个 Memora 安全题按固定规则从 10 个 persona 各取 4 题，选择时不查看答案或 verdict；它用于兼容性检查，不冒充新的外部留出集。",
            styles["body"],
        ),
        para(
            "答案由 MiniMax-M3 与 deepseek-v4-flash 各读取 250 次，再由另一固定模型逐 criterion 交叉判断，共 500 次 Judge；无自评、错配、重试或 unclear。95% 区间按 10 个场景/persona 做 5,000 次配对聚类 bootstrap；独立验证器从 500 条原始 verdict 重算指标、门槛和哈希，mismatchCount = 0。",
            styles["body"],
        ),
        para(
            "<b>公平性：</b>三组使用相同数据、SQLite 写入、检索策略、result limit、提示预算、Reader 与 Judge；唯一变化是版本状态的组织和选择策略。因此答案差异可以归因到召回上下文，而不是模型或数据切换。",
            styles["body"],
        ),
        para(
            "<b>指标口径：</b>主指标为 criterion accuracy；上下文指标为期望集合精确率、期望状态召回率和污染率，同时记录 token、召回条目与本地耗时。能力题同时检查正确值是否出现、兄弟状态是否被误当成当前值。",
            styles["body"],
        ),
        para(
            "<b>反馈证据：</b>每次生产召回保留选择意图、候选与抑制数量、返回状态数、fallback、token 和耗时；答案侧保存 Reader 输出与交叉 Judge verdict。两条证据链通过 caseId 对齐，使“召回了什么”和“最终答对没有”可以独立复算。",
            styles["body"],
        ),
        PageBreak(),
        para("4　实验结果", styles["h1"]),
    ]

    result_rows = [
        ["70 题能力面板", "原始全局混合", "线性新旧双态", "版本感知多状态", "相对原始提升"],
        ["criterion accuracy", "94.29%", "67.50%", "100.00%", "+5.71 点"],
        ["MPA / FAA / FAMA", "94.29 / 94.29 / 94.29%", "47.14 / 87.86 / 47.14%", "100 / 100 / 100%", "均 +5.71 点"],
        ["期望集合精确率", "0.00%", "0.00%", "100.00%", "+100.00 点"],
        ["期望状态召回率", "85.71%", "21.43%", "100.00%", "+14.29 点"],
        ["跨状态污染率", "100.00%", "100.00%", "0.00%", "-100.00 点"],
        ["平均注入 token", "557.89", "487.57", "395.90", "-29.04%"],
        ["平均召回条目", "4.00", "2.03", "1.29", "-67.86%"],
        ["本地平均召回", "0.622 ms", "0.822 ms", "0.569 ms", "-8.52%"],
    ]
    result_table = styled_table(
        result_rows,
        [0.26 * width, 0.18 * width, 0.18 * width, 0.18 * width, 0.20 * width],
        styles,
        padding=2.5,
        small=True,
    )
    result_table.setStyle(TableStyle([
        ("TEXTCOLOR", (3, 1), (4, -1), PASS),
        ("FONTNAME", (3, 1), (4, -1), "Songti-Bold"),
        ("ALIGN", (1, 1), (-1, -1), "CENTER"),
    ]))
    story += [
        result_table,
        para(
            "<b>如何解读：</b>+5.71 点是高准确率基线上的答案增益；更大的系统收益体现在上下文结构由“正确答案夹杂冲突状态”变为“正确且纯净的状态集合”。因此精确选择和污染率比单独的答案分数更能说明多分支记忆是否安全。",
            styles["body"],
        ),
        para("线性新旧双态为什么下降", styles["h2"]),
        para(
            "线性双态把本应并列的 branch/worktree/task 状态强行解释成一条 old → current 链，结果在非当前域问题中丢失有效状态，criterion accuracy 降到 67.50%。这不是更换模型造成的，而是“时间顺序可以代表全部有效性”的建模假设不适用于并行开发。版本坐标把时间关系降为同域内的更新依据，从根本上消除该冲突。",
            styles["body"],
        ),
        para("提升来自状态纯度，而不是牺牲已有能力", styles["h2"]),
        para(
            "原始方案在分支、worktree 和并行任务的“正确值出现”题上本来就能达到 100%，但会同时召回兄弟状态，因此期望集合精确率为 0%、污染率为 100%。版本感知方案保留正确值的同时清除无关状态；比较、迁移和回归问题仍按意图返回多个有标签版本。缺失 scope 时的安全弃权从 60% 提升到 100%，这是答案准确率净增益的主要来源。",
            styles["body"],
        ),
        para("稳健性检查没有发现受损样本", styles["h2"]),
        para(
            "相对原始方案逐题统计为 <b>7 改善、63 持平、0 受损</b>；两位 Reader 的准确率变化分别为 +2.86 和 +8.57 点，方向一致。40 题 Memora legacy 安全面板中三组提示和答案完全相同，FAMA 维持 2.19%，只说明旧的 unscoped 路径未退化，不把它解释为通用质量提升。独立验证对 500 条 verdict 的复算全部一致。",
            styles["body"],
        ),
        para("实际使用价值", styles["h2"]),
        para(
            "多 worktree 或并行 Agent 同时修改不同版本时，每个任务只看到自己的构建命令、依赖版本和临时假设，避免一个分支的 L0/L1 状态污染另一个分支。处理迁移、回归或发布差异时，系统又能主动取回多个带来源标签的状态供 Agent 对比，不必删除仍然有效的历史事实。token 减少 29.04%、条目减少 67.86%，也降低了模型在冲突上下文中选错状态的机会。",
            styles["body"],
        ),
        para(
            "最典型的受益场景是长期维护 main/release、多 worktree 并行开发、多个 Agent 同仓库分工，以及迁移和回归分析。它们共同特点不是存在一个绝对“最新事实”，而是存在多个各自在特定执行坐标上有效的事实。",
            styles["body"],
        ),
        para("5　证据边界", styles["h1"]),
        para(
            "<b>已验证：</b>真实 Git/worktree 探测、隐私坐标、并行 task 延续、SQLite 写入、同域去重、最终生产召回、版本选择、标签、双 Reader/交叉 Judge 和 legacy 兼容。",
            styles["body"],
        ),
        para(
            "<b>未覆盖：</b>自动 LLM 在自然对话中总能抽取正确 scopeLevel、在线 TCVDB/COS 延迟、复杂 merge/cherry-pick/分支重命名、自然流量冲突率和人类 Judge 标定；因此本地耗时下降不能直接外推为线上数据库性能。",
            styles["body"],
        ),
        para(
            "下一轮验证应优先补足三项：从真实开发对话构造自然冲突集，在线后端复测 P50/P95 延迟与 token 预算，并用人工抽检校准 Judge；这些检查不会改变本轮已冻结结果，只用于判断外部泛化和线上成本。",
            styles["body"],
        ),
        callout(
            "<b>成果长处：</b>在不更换 Reader/Judge、不过度依赖较弱双态基线的前提下，本方案相对原始 Agent Memory 同时取得答案正增益、状态集合完全正确、跨状态污染清零和显著 token/条目节省；这是面向多分支、多 worktree 与并行 Agent 的系统级改进。",
            width,
            styles,
        ),
        para(
            "证据　context-manifest.json · evaluations.jsonl · summary.json · independent-validation.json　|　上下文 2c64c12d…a1960f　|　原始评测 e546f4f9…65ee61",
            styles["small"],
        ),
        para(
            f"代码　{link('GitHub fork 分支与完整实现', BRANCH_URL)}",
            styles["small"],
        ),
    ]

    doc.build(story, canvasmaker=NumberedCanvas)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output",
        default="output/pdf/tencentdb-agent-memory-version-aware-multistate-cn.pdf",
        help="Output PDF path relative to the current working directory",
    )
    args = parser.parse_args()
    build_pdf(Path(args.output).resolve())


if __name__ == "__main__":
    main()
