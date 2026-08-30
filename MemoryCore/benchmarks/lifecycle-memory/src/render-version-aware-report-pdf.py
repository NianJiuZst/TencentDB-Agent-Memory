#!/usr/bin/env python3
"""Render the version-aware multi-state memory report as an exact three-page PDF."""

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


class ArchitectureFlow(Flowable):
    def __init__(self, width: float):
        super().__init__()
        self.width = width
        self.height = 64

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
            canvas.roundRect(x, 10, box_width, 42, 5, fill=1, stroke=1)
            canvas.setFillColor(NAVY)
            canvas.setFont("Heiti-Medium", 7.5)
            canvas.drawCentredString(x + box_width / 2, 35, title)
            canvas.setFillColor(MUTED)
            canvas.setFont("Heiti-Light", 5.8)
            canvas.drawCentredString(x + box_width / 2, 21, subtitle)
            if index < len(labels) - 1:
                arrow_x = x + box_width + 1
                canvas.setStrokeColor(TEAL)
                canvas.setFillColor(TEAL)
                canvas.line(arrow_x, 31, arrow_x + gap - 3, 31)
                canvas.line(arrow_x + gap - 6, 34, arrow_x + gap - 3, 31)
                canvas.line(arrow_x + gap - 6, 28, arrow_x + gap - 3, 31)


def register_fonts() -> None:
    pdfmetrics.registerFont(TTFont("Heiti-Light", "/System/Library/Fonts/STHeiti Light.ttc"))
    pdfmetrics.registerFont(TTFont("Heiti-Medium", "/System/Library/Fonts/STHeiti Medium.ttc"))


def make_styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle(
            "TitleCN", parent=base["Title"], fontName="Heiti-Medium", fontSize=20,
            leading=25, textColor=NAVY, alignment=TA_LEFT, spaceAfter=5,
        ),
        "subtitle": ParagraphStyle(
            "SubtitleCN", parent=base["Normal"], fontName="Heiti-Light", fontSize=8,
            leading=11, textColor=MUTED, spaceAfter=9,
        ),
        "h1": ParagraphStyle(
            "H1CN", parent=base["Heading1"], fontName="Heiti-Medium", fontSize=12,
            leading=16, textColor=NAVY, spaceBefore=7, spaceAfter=4, keepWithNext=True,
        ),
        "h2": ParagraphStyle(
            "H2CN", parent=base["Heading2"], fontName="Heiti-Medium", fontSize=9.2,
            leading=12, textColor=TEAL, spaceBefore=5, spaceAfter=3, keepWithNext=True,
        ),
        "body": ParagraphStyle(
            "BodyCN", parent=base["BodyText"], fontName="Heiti-Light", fontSize=8.2,
            leading=11.8, textColor=INK, alignment=TA_LEFT, wordWrap="CJK", spaceAfter=4,
        ),
        "small": ParagraphStyle(
            "SmallCN", parent=base["BodyText"], fontName="Heiti-Light", fontSize=6.9,
            leading=9.2, textColor=MUTED, wordWrap="CJK",
        ),
        "table": ParagraphStyle(
            "TableCN", parent=base["BodyText"], fontName="Heiti-Light", fontSize=7,
            leading=9.1, textColor=INK, wordWrap="CJK",
        ),
        "table_head": ParagraphStyle(
            "TableHeadCN", parent=base["BodyText"], fontName="Heiti-Medium", fontSize=7,
            leading=9.1, textColor=colors.white, wordWrap="CJK", alignment=TA_CENTER,
        ),
        "code": ParagraphStyle(
            "CodeCN", parent=base["Code"], fontName="Heiti-Light", fontSize=7,
            leading=9.4, textColor=INK, backColor=PALE_BLUE, leftIndent=5, rightIndent=5,
            borderPadding=4, borderColor=LINE, borderWidth=0.5, wordWrap="CJK",
        ),
        "callout": ParagraphStyle(
            "CalloutCN", parent=base["BodyText"], fontName="Heiti-Medium", fontSize=9,
            leading=13, textColor=NAVY, wordWrap="CJK",
        ),
    }


def para(text: str, style: ParagraphStyle) -> Paragraph:
    return Paragraph(text, style)


def styled_table(
    rows: list[list[str]],
    widths: list[float],
    styles: dict[str, ParagraphStyle],
    header: bool = True,
    padding: float = 4.0,
) -> Table:
    data = []
    for row_index, row in enumerate(rows):
        style = styles["table_head"] if header and row_index == 0 else styles["table"]
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
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    return table


def footer(canvas: Canvas, doc: SimpleDocTemplate) -> None:
    canvas.saveState()
    page_width, _ = A4
    canvas.setStrokeColor(LINE)
    canvas.line(16 * mm, 12.5 * mm, page_width - 16 * mm, 12.5 * mm)
    canvas.setFont("Heiti-Light", 6.3)
    canvas.setFillColor(MUTED)
    canvas.drawString(16 * mm, 7.9 * mm, "TencentDB Agent Memory · 版本/分支感知多状态记忆")
    canvas.drawRightString(page_width - 16 * mm, 7.9 * mm, f"{doc.page} / 3")
    canvas.restoreState()


def build_pdf(output: Path) -> None:
    register_fonts()
    styles = make_styles()
    output.parent.mkdir(parents=True, exist_ok=True)
    doc = SimpleDocTemplate(
        str(output), pagesize=A4, leftMargin=16 * mm, rightMargin=16 * mm,
        topMargin=14 * mm, bottomMargin=17 * mm,
        title="TencentDB Agent Memory 版本分支感知多状态记忆",
        author="TencentDB Agent Memory",
    )
    width = A4[0] - doc.leftMargin - doc.rightMargin
    story: list[object] = [
        para("版本/分支感知的多状态记忆闭环", styles["title"]),
        para(
            "TencentDB Agent Memory 实现与真实评测　|　2026-08-31　|　分支 codex/version-aware-multistate-memory　|　评分前提交 4d77e69",
            styles["subtitle"],
        ),
        callout(
            "<b>结论：</b>建议采用并灰度上线。版本能力 accuracy 达到 <b>100.00%</b>：对全局混合召回 +5.71 点 [2.86, 8.57]，对线性新旧双态 +32.50 点 [30.36, 34.64]。期望状态精确率 0% → 100%，污染率 100% → 0%，能力面板注入 token 分别减少 29.04% 和 18.80%。",
            width,
            styles,
        ),
        para("1　原理：并行有效域，不是全局新旧链", styles["h1"]),
        para(
            "同一项目的 main、release、两个 worktree 和两个并行任务可以同时正确。每条 L1 记忆附带 repository、branch、commit、worktree、task 与 scopeLevel。普通执行只返回当前有效域；比较、迁移、回归或历史问题才返回同仓库、带来源标签的多个状态；缺失仓库上下文时拒绝注入 scoped 记忆。提交号用于溯源，兄弟状态不互相覆盖。",
            styles["body"],
        ),
        ArchitectureFlow(width),
        para("写入、反馈与失败边界", styles["h2"]),
        para(
            "宿主传入 workspaceDir、taskId 或显式 versionContext；Git 探测器生成隐私哈希。上下文按“会话 + 任务”延续到异步 L1。去重、update/merge、删除和纠错边只作用于完全相同的有效域；新记录可查询且旧 ID 全部核验后才发布边。兄弟分支、worktree、任务不会被误删或误连。",
            styles["body"],
        ),
        para("2　TencentDB Agent Memory 接入", styles["h1"]),
    ]
    code_rows = [
        ["环节", "代码位置", "职责"],
        ["有效域", "lifecycle/version-scope.ts", "有效性、查询意图、标签与有界选择"],
        ["Git 探测", "lifecycle/git-context.ts", "同仓库/不同 worktree 身份；不落原始路径"],
        ["异步延续", "version-context-store.ts · pipeline-factory.ts", "并行 taskId 不串域"],
        ["写入去重", "record/l1-dedup.ts · l1-writer.ts", "同域更新；兄弟状态并存"],
        ["最终召回", "hooks/auto-recall.ts", "真实候选过取 → 生命周期 → 版本筛选 → 提示"],
        ["宿主入口", "tdai-core.ts · index.ts · gateway/*", "OpenClaw / Gateway 显式或自动传上下文"],
    ]
    story += [
        styled_table(code_rows, [0.15 * width, 0.37 * width, 0.48 * width], styles),
        para("建议配置", styles["h2"]),
        para(
            '{ "recall": { "lifecycle": { "enabled": true, "versionAwareMode": "strict",<br/>'
            '&nbsp;&nbsp;"autoDetectGit": true, "versionCandidateMultiplier": 4, "maxVersionStates": 6 } } }',
            styles["code"],
        ),
        para(
            "自动探测采用保守的 worktree 级作用域；并行任务应传稳定 taskId；确需跨 worktree 共享的分支事实由宿主显式传 scopeLevel=branch。默认开关保持关闭，便于按仓库灰度。",
            styles["small"],
        ),
        PageBreak(),
        para("3　冻结的真实生产路径实验", styles["h1"]),
        para(
            "所有协议、上下文哈希和门槛在看答案前固定。能力面板为 10 组编程状态 × 7 类问题，共 70 题；安全面板为固定 Memora 提交 a6493188… 的 10 个 persona × 4 题，共 40 题。公开题只检验旧式无作用域路径是否退化，能力题单独标明为受控生成数据。",
            styles["body"],
        ),
    ]
    design_rows = [
        ["层级", "实际执行", "规模 / 完整性"],
        ["状态基础设施", "真实临时 Git：main、release、两个 detached worktree、两个并行任务", "1 仓库；路径不持久化"],
        ["Agent Memory 路径", "真实 SQLite/FTS5 → writeMemory → performAutoRecall → 最终提示", "50 DB；260 写入；330 召回；fallback 0"],
        ["Reader", "MiniMax-M3 + deepseek-v4-flash；只复用逐字节相同提示", "每模型 250；合计 500"],
        ["Judge", "每个答案只由另一固定模型按冻结 criteria 判分", "500；自评/错配/重试/unclear 均 0"],
        ["独立复算", "从原始 verdict 重算指标、5,000 次聚类 bootstrap、门槛和哈希", "500 条；mismatch = 0"],
    ]
    story += [
        styled_table(design_rows, [0.16 * width, 0.55 * width, 0.29 * width], styles),
        para("4　总体结果", styles["h1"]),
    ]
    result_rows = [
        ["70 题能力面板", "全局混合", "线性新旧双态", "版本感知多状态"],
        ["criterion accuracy", "94.29%", "67.50%", "100.00%"],
        ["期望集合精确率", "0.00%", "0.00%", "100.00%"],
        ["期望状态召回率", "85.71%", "21.43%", "100.00%"],
        ["跨状态污染率", "100.00%", "100.00%", "0.00%"],
        ["平均注入 token", "557.89", "487.57", "395.90"],
        ["平均召回条目", "4.00", "2.03", "1.29"],
        ["本地平均召回", "0.622 ms", "0.822 ms", "0.569 ms"],
    ]
    result_table = styled_table(
        result_rows, [0.34 * width, 0.22 * width, 0.22 * width, 0.22 * width], styles
    )
    result_table.setStyle(TableStyle([
        ("TEXTCOLOR", (3, 1), (3, 7), PASS),
        ("FONTNAME", (3, 1), (3, 7), "Heiti-Medium"),
        ("ALIGN", (1, 1), (-1, -1), "CENTER"),
    ]))
    story += [result_table, para("5　各能力点提升", styles["h1"])]
    slice_rows = [
        ["能力点", "全局混合", "线性双态", "新方案", "提升（对前两组）"],
        ["分支当前态", "100.00%", "42.50%", "100.00%", "+0.00 / +57.50 点"],
        ["worktree 当前态", "100.00%", "50.00%", "100.00%", "+0.00 / +50.00 点"],
        ["并行任务当前态", "100.00%", "50.00%", "100.00%", "+0.00 / +50.00 点"],
        ["分支比较", "100.00%", "100.00%", "100.00%", "+0.00 / +0.00 点"],
        ["迁移", "100.00%", "100.00%", "100.00%", "+0.00 / +0.00 点"],
        ["回归", "100.00%", "100.00%", "100.00%", "+0.00 / +0.00 点"],
        ["缺失 scope 弃权", "60.00%", "30.00%", "100.00%", "+40.00 / +70.00 点"],
    ]
    story += [
        styled_table(
            slice_rows,
            [0.25 * width, 0.15 * width, 0.15 * width, 0.15 * width, 0.30 * width],
            styles,
            padding=3.5,
        ),
        para(
            "对全局混合召回：7 题改善、63 持平、0 受损，两位 Reader 方向 +2.86 / +8.57 点。对线性新旧双态：40 题改善、30 持平、0 受损，两位 Reader +27.86 / +37.14 点。",
            styles["body"],
        ),
        PageBreak(),
        para("6　如何解释结果", styles["h1"]),
        callout(
            "<b>旧/当前共同召回只是多状态的一个特例。</b>同一有效域发生替代时仍保留线性更新；不同分支、worktree、任务之间则是并列状态。线性双态把并列关系误当替代关系，正是其 worktree 与并行任务各损失 50 点的原因。",
            width,
            styles,
            color=PURPLE,
        ),
        para("为什么对全局混合召回只提升 5.71 点？", styles["h2"]),
        para(
            "受控题的记忆正文保留“State owner”描述，两种强 Reader 即使看到 4 个混合状态，也能在多数简单题中自行消歧，所以分支、worktree、任务当前态及跨分支问题的答案分数持平。但全局基线的期望集合精确率仍为 0%、污染率为 100%。新方案把依赖模型运气的消歧前移到系统层，并减少 29.04% token；真实任务更长、标签更弱或模型更小时，这种领先指标更重要。",
            styles["body"],
        ),
        para("公开安全面板", styles["h2"]),
        para(
            "40 个 Memora 问题的三组提示与答案逐字节相同：FAMA 均为 <b>2.19%</b>，差值 0.00 点，40 题全部持平。绝对值偏低，说明冻结的少量召回上下文本身不足；它只支持“版本逻辑不破坏旧式无作用域路径”，不能支持通用记忆质量提升。",
            styles["body"],
        ),
        para("7　上线价值与门禁", styles["h1"]),
    ]
    value_rows = [
        ["实际场景", "收益", "门禁"],
        ["多分支维护", "release 修补与 main 演进同时可查，不互相覆盖", "跨仓库/分支泄漏 = 0"],
        ["多 worktree", "同提交的本地实验状态隔离；比较时才联合", "错误删除兄弟状态 = 0"],
        ["并行 Agent 任务", "同 worktree 的 taskId 保持各自假设与命令", "同会话 task 串域 = 0"],
        ["迁移与回归", "保留来源标签，能正确映射两端状态", "比较状态集合完整"],
        ["上下文缺失", "拒绝用任意分支记忆猜当前值", "scoped 记忆注入 = 0"],
    ]
    story += [
        styled_table(value_rows, [0.20 * width, 0.52 * width, 0.28 * width], styles),
        para("8　证据边界", styles["h1"]),
    ]
    boundary_rows = [
        ["已经证明", "尚未证明"],
        [
            "真实 Git/worktree 探测、SQLite 写入、最终生产召回、双 Reader/交叉 Judge、作用域选择、向后兼容与独立复算；冻结的全部门槛通过。",
            "自动 LLM 抽取总能选对 scopeLevel；在线 TCVDB/COS 延迟；复杂 merge ancestry 与分支重命名；无控制真实编程流量中的冲突率；人类 Judge 标定。",
        ],
    ]
    boundary = styled_table(boundary_rows, [0.5 * width, 0.5 * width], styles)
    boundary.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (0, 0), PASS),
        ("BACKGROUND", (1, 0), (1, 0), WARN),
    ]))
    story += [
        boundary,
        callout(
            "<b>最终判断：</b>作为线性新旧双态的升级版本，版本感知多状态记忆有效且值得接入；先影子记录 scope 指标，再按仓库灰度。普通执行只读当前有效域，显式比较类问题才开放带标签多状态，缺失上下文必须弃权。",
            width,
            styles,
        ),
        Spacer(1, 3),
        para(
            "审计锚点　上下文 2c64c12d…a1960f　|　原始评测 e546f4f9…65ee61　|　500 Reader + 500 Judge　|　独立复算 500 条，0 mismatch",
            styles["small"],
        ),
        para(
            "证据目录　results/version-aware-final/context/context-manifest.json · e2e/evaluations.jsonl · e2e/summary.json · e2e/independent-validation.json",
            styles["small"],
        ),
    ]

    doc.build(story, onFirstPage=footer, onLaterPages=footer)


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
