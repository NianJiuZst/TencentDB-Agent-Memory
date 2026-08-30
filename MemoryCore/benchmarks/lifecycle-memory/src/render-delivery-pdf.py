#!/usr/bin/env python3
"""Render the compact Chinese lifecycle integration handoff as a three-page PDF."""

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
    KeepTogether,
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
FAIL = colors.HexColor("#B33A3A")


class ArchitectureFlow(Flowable):
    def __init__(self, width: float):
        super().__init__()
        self.width = width
        self.height = 58

    def draw(self) -> None:
        canvas = self.canv
        labels = [
            ("L1 写入 / 去重", "update · merge"),
            ("发布纠错边", "同作用域 + 后继可查"),
            ("真实 ID 召回", "SQLite · TCVDB"),
            ("V1 一跳替换", "阈值 · 容量 · 期限"),
            ("注入与观测", "Base fallback · metrics"),
        ]
        gap = 10
        box_width = (self.width - gap * 4) / 5
        for index, (title, subtitle) in enumerate(labels):
            x = index * (box_width + gap)
            canvas.setFillColor(PALE_TEAL if index in (1, 3) else PALE_BLUE)
            canvas.setStrokeColor(TEAL if index in (1, 3) else LINE)
            canvas.roundRect(x, 8, box_width, 42, 5, fill=1, stroke=1)
            canvas.setFillColor(NAVY)
            canvas.setFont("Heiti-Medium", 8.4)
            canvas.drawCentredString(x + box_width / 2, 34, title)
            canvas.setFillColor(MUTED)
            canvas.setFont("Heiti-Light", 6.7)
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


def paragraph(text: str, style: ParagraphStyle) -> Paragraph:
    return Paragraph(text, style)


def make_styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle(
            "TitleCN", parent=base["Title"], fontName="Heiti-Medium", fontSize=20,
            leading=27, textColor=NAVY, alignment=TA_LEFT, spaceAfter=6,
        ),
        "subtitle": ParagraphStyle(
            "SubtitleCN", parent=base["Normal"], fontName="Heiti-Light", fontSize=8.5,
            leading=12, textColor=MUTED, spaceAfter=12,
        ),
        "h1": ParagraphStyle(
            "H1CN", parent=base["Heading1"], fontName="Heiti-Medium", fontSize=12.5,
            leading=17, textColor=NAVY, spaceBefore=7, spaceAfter=5, keepWithNext=True,
        ),
        "h2": ParagraphStyle(
            "H2CN", parent=base["Heading2"], fontName="Heiti-Medium", fontSize=9.3,
            leading=13, textColor=TEAL, spaceBefore=5, spaceAfter=3, keepWithNext=True,
        ),
        "body": ParagraphStyle(
            "BodyCN", parent=base["BodyText"], fontName="Heiti-Light", fontSize=8.25,
            leading=12.2, textColor=INK, alignment=TA_LEFT, wordWrap="CJK", spaceAfter=4,
        ),
        "small": ParagraphStyle(
            "SmallCN", parent=base["BodyText"], fontName="Heiti-Light", fontSize=7.1,
            leading=10, textColor=MUTED, wordWrap="CJK",
        ),
        "table": ParagraphStyle(
            "TableCN", parent=base["BodyText"], fontName="Heiti-Light", fontSize=6.8,
            leading=9.2, textColor=INK, wordWrap="CJK",
        ),
        "table_head": ParagraphStyle(
            "TableHeadCN", parent=base["BodyText"], fontName="Heiti-Medium", fontSize=7,
            leading=9, textColor=colors.white, wordWrap="CJK", alignment=TA_CENTER,
        ),
        "code": ParagraphStyle(
            "CodeCN", parent=base["Code"], fontName="Heiti-Light", fontSize=6.9,
            leading=9.5, textColor=INK, backColor=PALE_BLUE, leftIndent=6, rightIndent=6,
            borderPadding=6, borderColor=LINE, borderWidth=0.5, wordWrap="CJK",
        ),
        "callout": ParagraphStyle(
            "CalloutCN", parent=base["BodyText"], fontName="Heiti-Medium", fontSize=9,
            leading=13.5, textColor=NAVY, wordWrap="CJK",
        ),
        "center": ParagraphStyle(
            "CenterCN", parent=base["BodyText"], fontName="Heiti-Medium", fontSize=8,
            leading=11, textColor=INK, alignment=TA_CENTER, wordWrap="CJK",
        ),
    }


def footer(canvas: Canvas, doc: SimpleDocTemplate) -> None:
    canvas.saveState()
    page_width, _ = A4
    canvas.setStrokeColor(LINE)
    canvas.line(17 * mm, 13 * mm, page_width - 17 * mm, 13 * mm)
    canvas.setFont("Heiti-Light", 6.8)
    canvas.setFillColor(MUTED)
    canvas.drawString(17 * mm, 8.2 * mm, "TencentDB Agent Memory · Lifecycle V1 纠错闭环")
    canvas.drawRightString(page_width - 17 * mm, 8.2 * mm, f"{doc.page} / 3")
    canvas.restoreState()


def result_table(styles: dict[str, ParagraphStyle], width: float) -> Table:
    head = ["证据层", "数据与指标", "实测结果", "判定"]
    rows = [
        [
            "运行时集成",
            "16 类 × 25 次；exact、旧记忆暴露、后继召回、误重定向、泄漏、fallback、p95",
            "7/7 门禁通过；exact=100%；暴露/误转/泄漏=0；后继与 fallback=100%；p95 增量 0.303 ms",
            "通过",
        ],
        [
            "Memora D16",
            "200 问、13 arms；MPA / FAA / FAMA、persona bootstrap CI",
            "Base 0.1428 → V1 0.1570；+0.0142，CI 触零。forgetting +0.0296；recommending +0.0768；remembering MPA -0.0153",
            "条件保留",
        ],
        [
            "Memora D18",
            "27,614 sessions；test=5,954；事件与前驱链接精度/召回",
            "event P/R/F1=0.9789/0.7964/0.8783；link precision=0.2005；任一正确链接率=0.4538",
            "建链失败",
        ],
        [
            "LongMemEval-V2",
            "固定 SHA：451 questions、200 trajectories；D11 token、支持度与 gate",
            "源数据审计通过；D11 token -20.84%，未调用答案模型；独立复核 0 mismatch，source gate 失败",
            "效率证据",
        ],
    ]
    data = [[paragraph(cell, styles["table_head"]) for cell in head]]
    data += [[paragraph(cell, styles["table"]) for cell in row] for row in rows]
    table = Table(data, colWidths=[0.14 * width, 0.27 * width, 0.45 * width, 0.14 * width], repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), NAVY),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("GRID", (0, 0), (-1, -1), 0.35, LINE),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F7F9FB")]),
        ("ALIGN", (-1, 1), (-1, -1), "CENTER"),
        ("TEXTCOLOR", (-1, 1), (-1, 1), PASS),
        ("TEXTCOLOR", (-1, 2), (-1, 2), WARN),
        ("TEXTCOLOR", (-1, 3), (-1, 3), FAIL),
        ("TEXTCOLOR", (-1, 4), (-1, 4), WARN),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    return table


def build_pdf(output: Path) -> None:
    register_fonts()
    styles = make_styles()
    output.parent.mkdir(parents=True, exist_ok=True)
    doc = SimpleDocTemplate(
        str(output), pagesize=A4, leftMargin=17 * mm, rightMargin=17 * mm,
        topMargin=15 * mm, bottomMargin=18 * mm, title="TencentDB Agent Memory 记忆纠错闭环接入与评测",
        author="TencentDB Agent Memory",
    )
    width = A4[0] - doc.leftMargin - doc.rightMargin
    story: list[object] = []

    story += [
        paragraph("TencentDB Agent Memory<br/>记忆纠错闭环接入与评测", styles["title"]),
        paragraph("交付日期：2026-08-30　|　实现分支：codex/lifecycle-memory-integration　|　范围：L1 auto-recall", styles["subtitle"]),
    ]
    summary = Table([[paragraph(
        "<b>交付结论</b><br/>Lifecycle V1 已接入真实 L1 写入与自动召回链路；结构化反馈、作用域隔离、10 ms 决策期限和 exact Base fallback 均有可复现实验覆盖。读取和反馈默认关闭，当前证据支持小流量条件上线，不支持全流量默认开启。",
        styles["callout"],
    )]], colWidths=[width])
    summary.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), PALE_TEAL),
        ("BOX", (0, 0), (-1, -1), 0.8, TEAL),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
    ]))
    story += [summary, Spacer(1, 7), paragraph("1　方案选择", styles["h1"])]
    story.append(paragraph(
        "本次复用既有实验中边界最清楚的 <b>Lifecycle V1</b>：在检索结果进入提示词之前，按已发布的“旧记忆 ID → 新记忆 ID”纠错边替换过时项。默认一跳、信任权重阈值 0.85、最多展开 64 个后继；超时、损坏、缺失或容量异常时返回内容与顺序均不变的 Base 前缀。",
        styles["body"],
    ))
    story.append(paragraph(
        "Memora 条件样本证明“已知纠错图 + 重定向”有效；D16 说明收益有明显任务异质性；D18 又证明纯文本自动找前驱不可靠。因此只接入可验证的结构化 update/merge 反馈，不接入文本自动建链。",
        styles["body"],
    ))
    story += [paragraph("2　闭环与 TencentDB 接入", styles["h1"]), ArchitectureFlow(width), Spacer(1, 2)]
    story.append(paragraph(
        "<b>反馈获取：</b><font color='#007F7B'>l1-writer.ts</font> 复用去重器的 update/merge 决策。只有全部 target_ids 在同一 team/user/agent/task 作用域核验成功，且新记录已经成功向量写入，才把 released 事件原子追加至 lifecycle-events/YYYY-MM-DD.jsonl；update/merge 权重为 0.95/0.90（策略信任权重，不是校准概率）。追加失败不阻断主写入。",
        styles["body"],
    ))
    story.append(paragraph(
        "<b>召回执行：</b><font color='#007F7B'>auto-recall.ts</font> 保留 keyword、embedding、SQLite hybrid 和 TCVDB native-hybrid 的真实 ID、分数与作用域；旁路加载 released 事件，经现有 IMemoryStore 按 ID 批量物化后继，再做一跳替换、字符预算和提示词注入。L1 跨 session，sessionKey 仅用于审计。",
        styles["body"],
    ))
    points = [
        ["配置", "src/config.ts · openclaw.plugin.json", "读/写双开关；默认 false"],
        ["反馈账本", "feedback-store.ts", "StorageAdapter：本地或 COS；严格 schema 与作用域"],
        ["生产执行", "production-runtime.ts", "总期限、容量、物化、exact fallback"],
        ["可观测", "metric-tracking-recall.ts", "mode / redirect / fallback / latency；不传正文或 ID"],
    ]
    point_data = [[paragraph(v, styles["table"]) for v in row] for row in points]
    point_table = Table(point_data, colWidths=[0.13 * width, 0.35 * width, 0.52 * width])
    point_table.setStyle(TableStyle([
        ("GRID", (0, 0), (-1, -1), 0.3, LINE), ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("BACKGROUND", (0, 0), (0, -1), PALE_BLUE), ("TEXTCOLOR", (0, 0), (0, -1), NAVY),
        ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 3.5), ("BOTTOMPADDING", (0, 0), (-1, -1), 3.5),
    ]))
    story += [point_table, PageBreak()]

    story += [paragraph("3　数据集、指标与实测结果", styles["h1"]), result_table(styles, width), Spacer(1, 7)]
    boundary_data = [
        [paragraph("已证明", styles["table_head"]), paragraph("尚未证明", styles["table_head"])],
        [
            paragraph("结构化纠错边能进入真实召回；作用域隔离、后继物化、超时/损坏/缺失回退可执行；条件场景存在答案收益。", styles["body"]),
            paragraph("全流量答案质量提升；真实编程长任务效果；纯文本端到端自动建链；D11 的答案级非劣。", styles["body"]),
        ],
    ]
    boundary = Table(boundary_data, colWidths=[width / 2, width / 2])
    boundary.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (0, 0), PASS), ("BACKGROUND", (1, 0), (1, 0), FAIL),
        ("GRID", (0, 0), (-1, -1), 0.4, LINE), ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 7), ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story += [paragraph("证据边界", styles["h2"]), boundary]
    story.append(paragraph(
        "<b>运行时证据：</b>results/runtime-integration 下同时保存 result-card.v1.json 与 independent-validation.v1.json。16 类用例覆盖 redirect、无事件、低权重、跨作用域、后继缺失和损坏状态；每类重复 25 次。p95 为本机旁路开销，不能外推到生产网络。",
        styles["body"],
    ))
    story.append(paragraph(
        "<b>实验判断：</b>D16 冻结答案实验经独立重算 1,894 条 verdict、13 个 arm 和 12 个 V1 比较，0 mismatch；D18 本次以真实 Memora test split 重跑后仍未过链接门禁；LongMemEval-V2 原始文件的三个 SHA 与固定 revision 一致，D11 独立 gate 仍失败。负结果均保留，未包装为通过。",
        styles["body"],
    ))
    story += [paragraph("复现命令", styles["h2"]), paragraph(
        "npm run eval:lifecycle-runtime-integration<br/>npm run validate:lifecycle-runtime-integration<br/>npm test　　npm run test:lifecycle-memory　　npm run build:plugin",
        styles["code"],
    ), PageBreak()]

    story += [paragraph("4　配置、灰度与验收", styles["h1"])]
    config = (
        '{<br/>&nbsp;&nbsp;"recall": {<br/>&nbsp;&nbsp;&nbsp;&nbsp;"adaptive": { "enabled": false },<br/>'
        '&nbsp;&nbsp;&nbsp;&nbsp;"lifecycle": {<br/>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"feedbackEnabled": true, '
        '"enabled": false,<br/>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"minConfidence": 0.85, "maxHops": 1,<br/>'
        '&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"maxExpansions": 64, "timeoutMs": 10, "maxEvents": 5000<br/>'
        '&nbsp;&nbsp;&nbsp;&nbsp;}<br/>&nbsp;&nbsp;}<br/>}'
    )
    story += [paragraph(config, styles["code"]), paragraph("阶段 1　影子反馈", styles["h2"])]
    story.append(paragraph(
        "仅开启 feedbackEnabled，保持 enabled=false。监控事件可解析率、作用域完整率、前驱核验率和后继可物化率；抽样核对 update/merge 是否真的表达状态替换。",
        styles["body"],
    ))
    story += [paragraph("阶段 2　条件灰度", styles["h2"])]
    story.append(paragraph(
        "优先覆盖 forgetting/recommending，或明确发生结构化 update/merge 的小流量。固定 V1 参数，不同时开启旧 adaptive 策略；逐级扩大 traffic，并与 Base 做答案正确率/任务成功率 A/B。",
        styles["body"],
    ))
    gate_rows = [
        ["跨作用域泄漏", "= 0", "立即关读取开关"],
        ["exact fallback 等价", "= 100%", "立即关读取开关"],
        ["后继可物化率", "≥ 99.9%", "暂停放量并修复反馈"],
        ["p95 总增量", "≤ 10 ms", "回退 Base；检查 COS/TCVDB"],
        ["答案正确率 / 任务成功率", "不劣于 Base", "最终质量门禁"],
    ]
    gate_data = [[paragraph(v, styles["table_head"]) for v in ["指标", "门槛", "失败动作"]]] + [
        [paragraph(v, styles["table"]) for v in row] for row in gate_rows
    ]
    gates = Table(gate_data, colWidths=[0.35 * width, 0.20 * width, 0.45 * width])
    gates.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), NAVY), ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Heiti-Medium"), ("GRID", (0, 0), (-1, -1), 0.35, LINE),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F7F9FB")]),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("ALIGN", (1, 1), (1, -1), "CENTER"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5), ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story += [paragraph("上线门禁", styles["h2"]), gates, paragraph("5　限制与最终验收", styles["h1"])]
    story.append(paragraph(
        "当前完成 auto-recall 提示词注入路径，尚未覆盖独立 memory search 工具调用；没有真实 COS/TCVDB 凭证，因此本次是本地 StorageAdapter、真实 SQLite 与 TCVDB native-hybrid 契约测试，不包含生产网络延迟。10 ms 期限能及时返回 Base，但底层不可取消的只读请求可能在后台结束。生产前仍需真实服务灰度探针。",
        styles["body"],
    ))
    final_box = Table([[paragraph(
        "<b>验收结论：</b>“纠错闭环已接入，结构化反馈与运行时契约通过”——成立。<br/>“通用答案质量已提升”或“端到端自动纠错已解决”——不成立，必须继续受灰度质量门禁约束。",
        styles["callout"],
    )]], colWidths=[width])
    final_box.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), PALE_BLUE), ("BOX", (0, 0), (-1, -1), 0.8, NAVY),
        ("LEFTPADDING", (0, 0), (-1, -1), 10), ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 8), ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
    ]))
    story.append(final_box)

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
