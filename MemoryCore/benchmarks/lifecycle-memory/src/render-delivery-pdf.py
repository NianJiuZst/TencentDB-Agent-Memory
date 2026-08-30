#!/usr/bin/env python3
"""Render the final Chinese production-path handoff as an exact three-page PDF."""

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
PALE_TEAL = colors.HexColor("#EAF7F5")
PALE_BLUE = colors.HexColor("#EDF3F8")
INK = colors.HexColor("#1E2935")
MUTED = colors.HexColor("#526170")
LINE = colors.HexColor("#CBD5DF")
PASS = colors.HexColor("#23855B")
WARN = colors.HexColor("#B26A00")


class ArchitectureFlow(Flowable):
    def __init__(self, width: float):
        super().__init__()
        self.width = width
        self.height = 60

    def draw(self) -> None:
        canvas = self.canv
        labels = [
            ("L1 更新判定", "update · merge"),
            ("发布可信边", "同作用域 + 后继可查"),
            ("真实自动召回", "ID · 分数 · 作用域"),
            ("解析当前状态", "一跳 · 有界回退"),
            ("查询感知视图", "当前态或历史 + 当前"),
        ]
        gap = 10
        box_width = (self.width - gap * 4) / 5
        for index, (title, subtitle) in enumerate(labels):
            x = index * (box_width + gap)
            canvas.setFillColor(PALE_TEAL if index in (1, 3) else PALE_BLUE)
            canvas.setStrokeColor(TEAL if index in (1, 3) else LINE)
            canvas.roundRect(x, 8, box_width, 43, 5, fill=1, stroke=1)
            canvas.setFillColor(NAVY)
            canvas.setFont("Heiti-Medium", 8.1)
            canvas.drawCentredString(x + box_width / 2, 35, title)
            canvas.setFillColor(MUTED)
            canvas.setFont("Heiti-Light", 6.2)
            canvas.drawCentredString(x + box_width / 2, 20, subtitle)
            if index < len(labels) - 1:
                arrow_x = x + box_width + 2
                canvas.setStrokeColor(TEAL)
                canvas.setFillColor(TEAL)
                canvas.line(arrow_x, 29, arrow_x + gap - 4, 29)
                canvas.line(arrow_x + gap - 7, 32, arrow_x + gap - 4, 29)
                canvas.line(arrow_x + gap - 7, 26, arrow_x + gap - 4, 29)


def register_fonts() -> None:
    pdfmetrics.registerFont(TTFont("Heiti-Light", "/System/Library/Fonts/STHeiti Light.ttc"))
    pdfmetrics.registerFont(TTFont("Heiti-Medium", "/System/Library/Fonts/STHeiti Medium.ttc"))


def make_styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle(
            "TitleCN", parent=base["Title"], fontName="Heiti-Medium", fontSize=19,
            leading=25, textColor=NAVY, alignment=TA_LEFT, spaceAfter=5,
        ),
        "subtitle": ParagraphStyle(
            "SubtitleCN", parent=base["Normal"], fontName="Heiti-Light", fontSize=8,
            leading=11, textColor=MUTED, spaceAfter=9,
        ),
        "h1": ParagraphStyle(
            "H1CN", parent=base["Heading1"], fontName="Heiti-Medium", fontSize=12,
            leading=16, textColor=NAVY, spaceBefore=6, spaceAfter=4, keepWithNext=True,
        ),
        "h2": ParagraphStyle(
            "H2CN", parent=base["Heading2"], fontName="Heiti-Medium", fontSize=9,
            leading=12, textColor=TEAL, spaceBefore=4, spaceAfter=2, keepWithNext=True,
        ),
        "body": ParagraphStyle(
            "BodyCN", parent=base["BodyText"], fontName="Heiti-Light", fontSize=8,
            leading=11.7, textColor=INK, alignment=TA_LEFT, wordWrap="CJK", spaceAfter=3.5,
        ),
        "small": ParagraphStyle(
            "SmallCN", parent=base["BodyText"], fontName="Heiti-Light", fontSize=6.8,
            leading=9.3, textColor=MUTED, wordWrap="CJK",
        ),
        "table": ParagraphStyle(
            "TableCN", parent=base["BodyText"], fontName="Heiti-Light", fontSize=6.7,
            leading=8.9, textColor=INK, wordWrap="CJK",
        ),
        "table_head": ParagraphStyle(
            "TableHeadCN", parent=base["BodyText"], fontName="Heiti-Medium", fontSize=6.7,
            leading=8.7, textColor=colors.white, wordWrap="CJK", alignment=TA_CENTER,
        ),
        "code": ParagraphStyle(
            "CodeCN", parent=base["Code"], fontName="Heiti-Light", fontSize=6.8,
            leading=9.2, textColor=INK, backColor=PALE_BLUE, leftIndent=6, rightIndent=6,
            borderPadding=5, borderColor=LINE, borderWidth=0.5, wordWrap="CJK",
        ),
        "callout": ParagraphStyle(
            "CalloutCN", parent=base["BodyText"], fontName="Heiti-Medium", fontSize=8.8,
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
) -> Table:
    data = []
    for row_index, row in enumerate(rows):
        style = styles["table_head"] if header and row_index == 0 else styles["table"]
        data.append([para(value, style) for value in row])
    table = Table(data, colWidths=widths, repeatRows=1 if header else 0)
    commands = [
        ("GRID", (0, 0), (-1, -1), 0.35, LINE),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]
    if header:
        commands += [
            ("BACKGROUND", (0, 0), (-1, 0), NAVY),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F7F9FB")]),
        ]
    table.setStyle(TableStyle(commands))
    return table


def footer(canvas: Canvas, doc: SimpleDocTemplate) -> None:
    canvas.saveState()
    page_width, _ = A4
    canvas.setStrokeColor(LINE)
    canvas.line(17 * mm, 13 * mm, page_width - 17 * mm, 13 * mm)
    canvas.setFont("Heiti-Light", 6.7)
    canvas.setFillColor(MUTED)
    canvas.drawString(17 * mm, 8.2 * mm, "TencentDB Agent Memory · 查询感知双态记忆闭环")
    canvas.drawRightString(page_width - 17 * mm, 8.2 * mm, f"{doc.page} / 3")
    canvas.restoreState()


def callout(text: str, width: float, styles: dict[str, ParagraphStyle], color=TEAL) -> Table:
    table = Table([[para(text, styles["callout"])]], colWidths=[width])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), PALE_TEAL),
        ("BOX", (0, 0), (-1, -1), 0.8, color),
        ("LEFTPADDING", (0, 0), (-1, -1), 9),
        ("RIGHTPADDING", (0, 0), (-1, -1), 9),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
    ]))
    return table


def build_pdf(output: Path) -> None:
    register_fonts()
    styles = make_styles()
    output.parent.mkdir(parents=True, exist_ok=True)
    doc = SimpleDocTemplate(
        str(output), pagesize=A4, leftMargin=17 * mm, rightMargin=17 * mm,
        topMargin=15 * mm, bottomMargin=18 * mm,
        title="TencentDB Agent Memory 查询感知双态记忆闭环",
        author="TencentDB Agent Memory",
    )
    width = A4[0] - doc.leftMargin - doc.rightMargin
    story: list[object] = [
        para("TencentDB Agent Memory<br/>查询感知双态记忆闭环", styles["title"]),
        para(
            "交付日期：2026-08-31　|　分支：codex/lifecycle-memory-integration　|　预评分提交：59129af",
            styles["subtitle"],
        ),
        callout(
            "<b>结论：</b>最终方案已接入真实自动召回并完成新一轮答案评测。时序 accuracy 72.22% → 99.58%（+27.36 点，95% 区间 [26.53, 27.78]）；历史 +48.75 点，变化 +33.33 点，当前态与 150 个自然问题均不变；总体注入 token 仅 +0.54%。建议只对明确历史/变化查询返回带标签的新旧状态。",
            width,
            styles,
        ),
        para("1　方案原理", styles["h1"]),
        para(
            "旧记忆过时不代表永远无价值。当前问题只需要新值；历史回顾和变化解释同时需要旧值与新值。系统保留追加式更新链，但按查询提供两个读取视图：普通、当前和汇总问题只注入 <b>CURRENT / ACTIVE</b>；明确历史或变化问题才在一个候选槽内注入 <b>HISTORICAL / SUPERSEDED</b> 与 <b>CURRENT / ACTIVE</b>。删除或撤回关系永不返回旧内容。",
            styles["body"],
        ),
        ArchitectureFlow(width),
        para(
            "双态触发同时要求：结构化 update、权重 ≥ 0.85、前驱出现在本次原始候选、事件与查询处于相同 team/user/agent/task 边界、问题文本属于历史态或状态变化。每个当前候选最多绑定一个原始排名最靠前的前驱。",
            styles["body"],
        ),
        para("2　代码如何实现", styles["h1"]),
    ]
    code_rows = [
        ["环节", "代码位置", "职责"],
        ["配置", "config.ts · openclaw.plugin.json", "反馈、读取、查询感知开关；默认关闭"],
        ["写入反馈", "core/record/l1-writer.ts", "核验旧 ID 与新记录可查询后发布更新边"],
        ["账本隔离", "core/lifecycle/feedback-store.ts", "事件校验、追加、容量和作用域过滤"],
        ["查询路由", "core/lifecycle/temporal-intent.ts", "只读问题文本，识别当前、历史、变化、汇总"],
        ["解析执行", "core/lifecycle/production-runtime.ts", "过滤可信边、物化后继、当前态解析、双态与回退"],
        ["最终注入", "core/hooks/auto-recall.ts", "接入检索真实 ID，生成最终上下文"],
        ["数值指标", "core/report/metric-tracking-recall.ts", "mode、redirect、pair、fallback、latency"],
    ]
    story += [
        styled_table(code_rows, [0.13 * width, 0.35 * width, 0.52 * width], styles),
        para("反馈与失败边界", styles["h2"]),
        para(
            "去重器给出 update / merge 与 target_ids；旧 ID 全部在相同作用域核验且新记录向量 upsert 成功后，才追加“前驱 → 后继”事件。update/merge 权重为 0.95/0.90。运行时只上报数值，不上传正文或 ID。账本异常或 10 ms 超时回退原检索前缀；双态渲染异常保留已经解析出的当前态。",
            styles["body"],
        ),
        PageBreak(),
        para("3　最终生产路径答案评测", styles["h1"]),
        para(
            "数据固定为 Memora 同一修订、10 个 persona。自然面板为完整 150 个周级问题；时序面板为 20 组结构化偏好更新，每组询问当前、历史和变化，共 60 题。对照是“当前态单路”，实验组是“查询感知双态”。",
            styles["body"],
        ),
    ]
    design_rows = [
        ["层级", "实际执行", "规模 / 完整性"],
        ["生产上下文", "parseConfig → 持久化事件 → performAutoRecall → 作用域 → 后继物化 → 路由 → 最终提示", "420 次；错误/回退/配对异常/非触发差异均为 0"],
        ["答案生成", "两种固定 Reader；严格复用逐字节相同提示", "每个 Reader 250 个唯一提示；合计 500 次"],
        ["答案判分", "每个答案只由另一固定模型按 criteria 判分；禁止自评", "500 次；模型错配 0；自评 0；可恢复重试 3"],
        ["独立复算", "从原始 verdict 重算分数、聚合、5,000 次聚类抽样、门槛和哈希", "500 条全部复算；mismatch = 0"],
        ["代码回归", "常规测试、生命周期 benchmark、聚焦类型检查、插件构建", "80/80；159/159；类型检查与构建通过"],
    ]
    story += [
        styled_table(design_rows, [0.16 * width, 0.54 * width, 0.30 * width], styles),
        para("主要结果", styles["h2"]),
    ]
    result_rows = [
        ["面板", "n", "当前态单路", "查询感知双态", "配对差值 [95% 区间]"],
        ["自然问题 FAMA", "150", "28.72%", "28.72%", "0.00 点 [0.00, 0.00]"],
        ["当前态 accuracy", "20", "100.00%", "100.00%", "0.00 点 [0.00, 0.00]"],
        ["历史态 accuracy", "20", "50.00%", "98.75%", "+48.75 点 [46.25, 50.00]"],
        ["状态变化 accuracy", "20", "66.67%", "100.00%", "+33.33 点 [33.33, 33.33]"],
        ["全部时序 accuracy", "60", "72.22%", "99.58%", "+27.36 点 [26.53, 27.78]"],
    ]
    results = styled_table(
        result_rows,
        [0.25 * width, 0.08 * width, 0.18 * width, 0.20 * width, 0.29 * width],
        styles,
    )
    results.setStyle(TableStyle([
        ("TEXTCOLOR", (4, 3), (4, 5), PASS),
        ("FONTNAME", (4, 3), (4, 5), "Heiti-Medium"),
        ("ALIGN", (1, 1), (-1, -1), "CENTER"),
    ]))
    story += [
        results,
        para(
            "时序 FAMA 50.00% → 99.17%（+49.17 点）；40 题改善、20 题持平、0 题受损。两个 Reader 的时序 accuracy 方向为 +27.78 与 +26.94 点。全部 210 题平均注入 token 549.20 → 552.19，仅 +0.54%。所有评分前冻结门槛通过。",
            styles["body"],
        ),
        para("指标与证据边界", styles["h2"]),
    ]
    metric_rows = [
        ["指标", "定义 / 边界"],
        ["criterion accuracy", "每题冻结的应出现/不应出现标准正确率；时序问题等权"],
        ["FAMA", "max(0, MPA - λ × (1 - FAA))；λ 为遗忘标准占比"],
        ["95% 区间", "按 persona 做配对聚类 bootstrap，5,000 次；10 个聚类"],
        ["token", "实际生产 prependContext + appendSystemContext 的编码长度"],
    ]
    story += [
        styled_table(metric_rows, [0.24 * width, 0.76 * width], styles),
        callout(
            "<b>这是真实答案评测，但边界清楚：</b>配置、事件、隔离、后继物化、路由、预算和最终提示都执行生产代码；候选排名由冻结的 IMemoryStore 契约适配器提供，因此没有测真实 SQLite、TCVDB 或 COS 网络延迟。",
            width,
            styles,
            color=WARN,
        ),
        PageBreak(),
        para("4　配置、灰度与验收", styles["h1"]),
    ]
    config = (
        '{<br/>&nbsp;&nbsp;"recall": {<br/>&nbsp;&nbsp;&nbsp;&nbsp;"lifecycle": {<br/>'
        '&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"feedbackEnabled": true, "enabled": true,<br/>'
        '&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"dualStateMode": "query_aware",<br/>'
        '&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"minConfidence": 0.85, "maxHops": 1,<br/>'
        '&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"maxExpansions": 64, "timeoutMs": 10, "maxEvents": 5000<br/>'
        '&nbsp;&nbsp;&nbsp;&nbsp;}<br/>&nbsp;&nbsp;}<br/>}'
    )
    story += [para(config, styles["code"]), Spacer(1, 5)]
    phase_rows = [
        ["阶段", "开关", "验证重点"],
        ["影子反馈", "feedbackEnabled=true；读取保持关闭", "人工抽查更新边、作用域和后继可查询"],
        ["当前态灰度", "enabled=true；双态保持关闭", "后继可物化、回退、泄漏、时延"],
        ["查询感知灰度", "dualStateMode=query_aware", "历史/变化正确率、误触发、局部 token"],
    ]
    story += [
        styled_table(phase_rows, [0.20 * width, 0.35 * width, 0.45 * width], styles),
        para("上线门禁", styles["h2"]),
    ]
    gate_rows = [
        ["指标", "门槛", "失败动作"],
        ["跨作用域泄漏", "= 0", "立即关闭读取"],
        ["删除旧值暴露", "= 0", "立即关闭双态与读取"],
        ["后继可物化率", "≥ 99.9%", "暂停放量，修复反馈"],
        ["生命周期 p95 总增量", "≤ 10 ms", "关闭读取，检查存储"],
        ["历史/变化答案正确率", "不劣化", "停止查询感知灰度"],
    ]
    story += [
        styled_table(gate_rows, [0.36 * width, 0.20 * width, 0.44 * width], styles),
        para("5　限制与下一步", styles["h1"]),
    ]
    boundary_rows = [
        ["本次已经证明", "本次尚未证明"],
        [
            "可靠结构化更新边能进入最终自动召回；历史/变化答案显著改善；当前和自然问题不变；成本门、完整性门和独立复算通过。",
            "纯文本自动建链；自然历史查询占比；人类裁判标定；真实 COS/TCVDB 网络时延；多轮编程任务收益；独立 memory search 工具路径。",
        ],
    ]
    boundary = styled_table(boundary_rows, [0.5 * width, 0.5 * width], styles)
    boundary.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (0, 0), PASS),
        ("BACKGROUND", (1, 0), (1, 0), WARN),
    ]))
    story += [
        boundary,
        para(
            "Memora 周级问题曾用于此前开发，因此本次属于冻结输入上的新调用与生产链路答案证据，不是全新外部留出集。下一步应在真实流量影子日志中人工标定更新边和查询路由，再做按查询类型分层的线上对照；独立 memory search 工具需另行接入同一解析器。",
            styles["body"],
        ),
        callout(
            "<b>最终验收：</b>采用查询感知双态作为受控生产能力——通过。普通/当前问题继续只用当前态；历史/变化问题才返回带标签的新旧状态；删除旧值、跨作用域内容和不可信边始终禁止返回。",
            width,
            styles,
        ),
        para(
            "审计锚点　上下文 SHA-256：0c940cc4…d6a13　|　原始答案 SHA-256：9700a555…29fe7　|　独立复算：500 条，0 mismatch",
            styles["small"],
        ),
    ]

    doc.build(story, onFirstPage=footer, onLaterPages=footer)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output",
        default="output/pdf/tencentdb-agent-memory-lifecycle-delivery-cn.pdf",
        help="Output PDF path relative to the current working directory",
    )
    args = parser.parse_args()
    build_pdf(Path(args.output).resolve())


if __name__ == "__main__":
    main()
