#!/usr/bin/env python3
"""Render the concise three-page version-aware memory report in Songti."""

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
    Spacer,
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
WARN = colors.HexColor("#B26A00")
SONGTI_PATH = "/System/Library/Fonts/Supplemental/Songti.ttc"
BRANCH_URL = "https://github.com/NianJiuZst/TencentDB-Agent-Memory/tree/codex/version-aware-multistate-memory"
CODE_ROOT = "https://github.com/NianJiuZst/TencentDB-Agent-Memory/blob/codex/version-aware-multistate-memory/MemoryCore"


class ArchitectureFlow(Flowable):
    def __init__(self, width: float):
        super().__init__()
        self.width = width
        self.height = 54

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
            canvas.roundRect(x, 6, box_width, 39, 5, fill=1, stroke=1)
            canvas.setFillColor(NAVY)
            canvas.setFont("Songti-Bold", 7.1)
            canvas.drawCentredString(x + box_width / 2, 29, title)
            canvas.setFillColor(MUTED)
            canvas.setFont("Songti", 5.5)
            canvas.drawCentredString(x + box_width / 2, 16, subtitle)
            if index < len(labels) - 1:
                arrow_x = x + box_width + 1
                canvas.setStrokeColor(TEAL)
                canvas.setFillColor(TEAL)
                canvas.line(arrow_x, 26, arrow_x + gap - 3, 26)
                canvas.line(arrow_x + gap - 6, 29, arrow_x + gap - 3, 26)
                canvas.line(arrow_x + gap - 6, 23, arrow_x + gap - 3, 26)


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
            "TitleCN", parent=base["Title"], fontName="Songti-Bold", fontSize=19,
            leading=23, textColor=NAVY, alignment=TA_LEFT, spaceAfter=4,
        ),
        "subtitle": ParagraphStyle(
            "SubtitleCN", parent=base["Normal"], fontName="Songti", fontSize=7.7,
            leading=10.5, textColor=MUTED, spaceAfter=7,
        ),
        "h1": ParagraphStyle(
            "H1CN", parent=base["Heading1"], fontName="Songti-Bold", fontSize=11.5,
            leading=14.5, textColor=NAVY, spaceBefore=5, spaceAfter=3, keepWithNext=True,
        ),
        "h2": ParagraphStyle(
            "H2CN", parent=base["Heading2"], fontName="Songti-Bold", fontSize=9,
            leading=11.5, textColor=TEAL, spaceBefore=4, spaceAfter=2, keepWithNext=True,
        ),
        "body": ParagraphStyle(
            "BodyCN", parent=base["BodyText"], fontName="Songti", fontSize=7.7,
            leading=10.7, textColor=INK, alignment=TA_LEFT, wordWrap="CJK", spaceAfter=3,
        ),
        "small": ParagraphStyle(
            "SmallCN", parent=base["BodyText"], fontName="Songti", fontSize=6.25,
            leading=8.1, textColor=MUTED, wordWrap="CJK",
        ),
        "table": ParagraphStyle(
            "TableCN", parent=base["BodyText"], fontName="Songti", fontSize=6.45,
            leading=8.1, textColor=INK, wordWrap="CJK",
        ),
        "table_small": ParagraphStyle(
            "TableSmallCN", parent=base["BodyText"], fontName="Songti", fontSize=5.9,
            leading=7.4, textColor=INK, wordWrap="CJK",
        ),
        "table_head": ParagraphStyle(
            "TableHeadCN", parent=base["BodyText"], fontName="Songti-Bold", fontSize=6.45,
            leading=8.1, textColor=colors.white, wordWrap="CJK", alignment=TA_CENTER,
        ),
        "table_head_small": ParagraphStyle(
            "TableHeadSmallCN", parent=base["BodyText"], fontName="Songti-Bold", fontSize=5.9,
            leading=7.4, textColor=colors.white, wordWrap="CJK", alignment=TA_CENTER,
        ),
        "code": ParagraphStyle(
            "CodeCN", parent=base["Code"], fontName="Songti", fontSize=6.6,
            leading=8.7, textColor=INK, backColor=PALE_BLUE, leftIndent=4, rightIndent=4,
            borderPadding=3, borderColor=LINE, borderWidth=0.5, wordWrap="CJK",
        ),
        "callout": ParagraphStyle(
            "CalloutCN", parent=base["BodyText"], fontName="Songti", fontSize=8.6,
            leading=12.5, textColor=NAVY, wordWrap="CJK",
        ),
        "metric_value": ParagraphStyle(
            "MetricValueCN", parent=base["BodyText"], fontName="Songti-Bold", fontSize=12.5,
            leading=14.5, textColor=TEAL, alignment=TA_CENTER,
        ),
        "metric_label": ParagraphStyle(
            "MetricLabelCN", parent=base["BodyText"], fontName="Songti", fontSize=6.2,
            leading=7.8, textColor=MUTED, alignment=TA_CENTER,
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
        topMargin=13 * mm, bottomMargin=17 * mm,
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
    query_rows = [
        ["查询模式", "系统行为", "返回形式"],
        ["普通当前态", "按 task → worktree → branch → repo 过滤", "当前域；ACTIVE SCOPE"],
        ["比较/迁移/回归/历史", "同仓库每个有效域先保留一条，再补齐", "有界多状态；VERSION STATE"],
        ["点名两个分支", "优先 branch 状态，不带入全部 task/worktree", "分支、提交、worktree、task 标签"],
        ["缺少仓库上下文", "抑制全部 scoped 候选", "仅兼容 legacy；不猜当前值"],
    ]
    loop_rows = [
        ["阶段", "实现", "防污染约束"],
        ["capture", "workspaceDir / taskId / versionContext", "探测失败不猜身份"],
        ["L0→L1", "sessionKey + sessionId + taskId 延续坐标", "并行 task 不串域"],
        ["写入/纠错", "精确域内 dedup、update、删除和建边", "兄弟状态不误删/误连"],
        ["最终召回", "真实池 4 倍过取 → 生命周期 → 版本选择", "正确状态不被其他分支挤出"],
        ["反馈", "记录意图、抑制数、状态数、fallback、token、延迟", "调策略，不跨域改写事实"],
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
        styled_table(scope_rows, [0.15 * width, 0.29 * width, 0.21 * width, 0.35 * width], styles, padding=2.2),
        Spacer(1, 3),
        styled_table(query_rows, [0.20 * width, 0.46 * width, 0.34 * width], styles, padding=2.2, small=True),
        Spacer(1, 3),
        styled_table(loop_rows, [0.16 * width, 0.50 * width, 0.34 * width], styles, padding=2.1, small=True),
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
    method_rows = [
        ["实验环节", "冻结方法", "实际执行量"],
        ["三组对照", "原始全局混合 / 线性双态 / 版本感知多状态", "110 题 × 3 组"],
        ["Git 状态", "main、release、两个 detached worktree、两个并行 task", "1 个真实仓库"],
        ["Agent Memory 写入", "真实 SQLite/FTS5 + writeMemory", "50 DB；260 次"],
        ["最终上下文", "performAutoRecall + 生命周期 + 版本选择 + 预算", "330 次；fallback 0"],
        ["Reader", "MiniMax-M3 + deepseek-v4-flash", "每模型 250；共 500"],
        ["Judge", "每个答案只由另一模型逐 criterion 判断", "500；无自评/错配/重试/unclear"],
        ["不确定性", "5,000 次配对聚类 bootstrap", "10 场景/persona；95% 区间"],
        ["独立复算", "原始 verdict 重算指标、门槛和哈希", "500 条；mismatch 0"],
    ]
    story += [
        styled_table(code_rows, [0.18 * width, 0.30 * width, 0.52 * width], styles, padding=2.4),
        para("配置入口", styles["h2"]),
        para(
            '{ "recall": { "lifecycle": { "enabled": true, "versionAwareMode": "strict", '
            '"autoDetectGit": true, "versionCandidateMultiplier": 4, "maxVersionStates": 6 } } }',
            styles["code"],
        ),
        para("3　数据集与实验方法", styles["h1"]),
        styled_table(dataset_rows, [0.18 * width, 0.36 * width, 0.46 * width], styles, padding=2.3, small=True),
        Spacer(1, 4),
        styled_table(method_rows, [0.18 * width, 0.51 * width, 0.31 * width], styles, padding=2.2, small=True),
        para(
            "主指标：criterion accuracy。上下文指标：期望集合精确率、期望状态召回率、污染率；同时记录 token、条目和本地耗时。能力题同时检查正确值是否出现、兄弟状态是否被误当成当前值。",
            styles["small"],
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
    slice_rows = [
        ["能力点", "原始全局混合", "版本感知多状态", "提升"],
        ["分支当前态", "100.00%", "100.00%", "+0.00 点"],
        ["worktree 当前态", "100.00%", "100.00%", "+0.00 点"],
        ["并行任务当前态", "100.00%", "100.00%", "+0.00 点"],
        ["分支比较 / 迁移 / 回归", "100.00%", "100.00%", "+0.00 点；污染 100% → 0%"],
        ["缺失 scope 弃权", "60.00%", "100.00%", "+40.00 点"],
    ]
    robust_rows = [
        ["稳健性 / 安全检查", "结果"],
        ["逐题结果（相对原始）", "7 改善、63 持平、0 受损"],
        ["两位 Reader 方向", "+2.86 / +8.57 点，方向一致"],
        ["40 题 Memora 安全", "提示与答案完全相同；FAMA 2.19% → 2.19%，只证明 legacy 不退化"],
        ["独立验证", "passed；500 条 verdict 全量复算；mismatchCount = 0"],
    ]
    boundary_rows = [
        ["已由本实验验证", "本实验未覆盖"],
        [
            "真实 Git/worktree、隐私坐标、并行 task 延续、SQLite 写入、同域去重、生产召回、版本选择、标签、双 Reader/交叉 Judge、legacy 兼容。",
            "自动 LLM 总能抽取正确 scopeLevel；在线 TCVDB/COS 延迟；复杂 merge/cherry-pick/分支重命名；自然流量冲突率；人类 Judge 标定。",
        ],
    ]
    boundary = styled_table(boundary_rows, [0.53 * width, 0.47 * width], styles, padding=3.2)
    boundary.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (0, 0), PASS),
        ("BACKGROUND", (1, 0), (1, 0), WARN),
    ]))
    story += [
        result_table,
        para("各能力点", styles["h2"]),
        styled_table(slice_rows, [0.29 * width, 0.20 * width, 0.22 * width, 0.29 * width], styles, padding=2.5, small=True),
        para("稳健性与安全", styles["h2"]),
        styled_table(robust_rows, [0.30 * width, 0.70 * width], styles, padding=2.5, small=True),
        para("5　证据边界", styles["h1"]),
        boundary,
        Spacer(1, 4),
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
