# -*- coding: utf-8 -*-
"""Build one DOCX per language from the bilingual Markdown set, then export PDF with LibreOffice Kit."""
import os
import re
from docx import Document
from docx.shared import Pt, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

from pathlib import Path
ROOT = str(Path(__file__).resolve().parents[1])
OUT_DIR = os.path.join(ROOT, 'docs', 'export')
os.makedirs(OUT_DIR, exist_ok=True)

ZH_DOCS = [
    ('README.zh-CN.md', '项目总览'),
    ('docs/README.md', '文档总览'),
    ('docs/000-philosophy.zh-CN.md', '000 设计哲学'),
    ('docs/001-domain.zh-CN.md', '001 领域模型'),
    ('docs/002-authorization.zh-CN.md', '002 授权与准入'),
    ('docs/003-execution.zh-CN.md', '003 执行'),
    ('docs/004-prompts.zh-CN.md', '004 提示词'),
    ('docs/005-panel.md', '005 面板'),
    ('docs/006-deployment.zh-CN.md', '006 部署'),
    ('docs/007-architecture.zh-CN.md', '007 架构'),
    ('docs/008-cookbook.md', '008 常见做法与排障'),
    ('EXTENSIONS.zh-CN.md', '扩展：多通道'),
    ('docs/extensions/capability-matrix.zh-CN.md', '能力矩阵'),
    ('docs/extensions/ADR-005-weixin-backend.md', 'ADR-005 微信后端'),
    ('docs/extensions/ADR-006-health-key-compatibility.md', 'ADR-006 健康条目键兼容'),
    ('docs/extensions/ADR-007-weixin-capability-alignment.md', 'ADR-007 微信能力对齐'),
    ('docs/extensions/ADR-008-outbound-attachments.md', 'ADR-008 出站附件'),
    ('docs/extensions/ADR-009-projex-feedback-and-parity.zh-CN.md', 'ADR-009 Projex 反馈与对齐'),
    ('docs/extensions/ADR-010-yunxiao-signin-status-and-identity.zh-CN.md', 'ADR-010 云效登录与状态'),
    ('docs/extensions/ADR-011-weixin-feishu-alignment.zh-CN.md', 'ADR-011 微信对齐飞书'),
    ('docs/extensions/ADR-012-wecom-feishu-alignment.zh-CN.md', 'ADR-012 企业微信对齐飞书'),
]

EN_DOCS = [
    ('README.md', 'Project overview'),
    ('docs/README.en-US.md', 'Documentation overview'),
    ('docs/000-philosophy.md', '000 Philosophy'),
    ('docs/001-domain.md', '001 Domain model'),
    ('docs/002-authorization.md', '002 Authorization'),
    ('docs/003-execution.md', '003 Execution'),
    ('docs/004-prompts.md', '004 Prompts'),
    ('docs/005-panel.en-US.md', '005 Panel'),
    ('docs/006-deployment.md', '006 Deployment'),
    ('docs/007-architecture.md', '007 Architecture'),
    ('docs/008-cookbook.en-US.md', '008 Cookbook'),
    ('EXTENSIONS.md', 'Extensions: the multi-channel layer'),
    ('docs/extensions/capability-matrix.md', 'Capability matrix'),
    ('docs/extensions/ADR-005-weixin-backend.en-US.md', 'ADR-005 WeChat backend'),
    ('docs/extensions/ADR-006-health-key-compatibility.en-US.md', 'ADR-006 Health key compatibility'),
    ('docs/extensions/ADR-007-weixin-capability-alignment.en-US.md', 'ADR-007 WeChat capability alignment'),
    ('docs/extensions/ADR-008-outbound-attachments.en-US.md', 'ADR-008 Outbound attachments'),
    ('docs/extensions/ADR-009-projex-feedback-and-parity.md', 'ADR-009 Projex feedback and parity'),
    ('docs/extensions/ADR-010-yunxiao-signin-status-and-identity.md', 'ADR-010 Yunxiao sign-in and status'),
    ('docs/extensions/ADR-011-weixin-feishu-alignment.md', 'ADR-011 Aligning WeChat with Feishu'),
    ('docs/extensions/ADR-012-wecom-feishu-alignment.md', 'ADR-012 Aligning WeCom with Feishu'),
]

INLINE_LINK = re.compile(r'\[([^\]]+)\]\(([^)]+)\)')
INLINE_CODE = re.compile(r'`([^`]+)`')
INLINE_BOLD = re.compile(r'\*\*([^*]+)\*\*')
HTML_TAG = re.compile(r'</?(?:sub|sup|br|p|span|a|em|strong|img)\b[^>]*>', re.IGNORECASE)


def set_run_font(run, name='微软雅黑', size=10.5, bold=False, color=None, mono=False):
    run.font.name = 'Consolas' if mono else name
    run.font.size = Pt(size)
    run.bold = bold
    if color:
        run.font.color.rgb = color
    r = run._element
    rPr = r.get_or_add_rPr()
    rFonts = rPr.find(qn('w:rFonts'))
    if rFonts is None:
        rFonts = OxmlElement('w:rFonts')
        rPr.append(rFonts)
    rFonts.set(qn('w:eastAsia'), name)


def add_inline(paragraph, text, size=10.5, bold=False):
    """Add text with simple inline formatting: links -> text, code -> mono, **bold** -> bold."""
    text = HTML_TAG.sub('', text)
    text = INLINE_LINK.sub(lambda m: m.group(1), text)
    for part in re.split(r'(\*\*[^*]+\*\*)', text):
        if not part:
            continue
        is_bold = bold
        if part.startswith('**') and part.endswith('**') and len(part) > 4:
            part = part[2:-2]
            is_bold = True
        pos = 0
        for m in INLINE_CODE.finditer(part):
            if m.start() > pos:
                run = paragraph.add_run(part[pos:m.start()])
                set_run_font(run, size=size, bold=is_bold)
            run = paragraph.add_run(m.group(1))
            set_run_font(run, size=size - 1, bold=is_bold, mono=True)
            pos = m.end()
        if pos < len(part):
            run = paragraph.add_run(part[pos:])
            set_run_font(run, size=size, bold=is_bold)


def add_page_number_footer(section, label):
    p = section.footer.paragraphs[0]
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = p.add_run(label + '    ')
    set_run_font(run, size=8, color=RGBColor(0x88, 0x88, 0x88))
    fld = OxmlElement('w:fldSimple')
    fld.set(qn('w:instr'), 'PAGE')
    r = OxmlElement('w:r')
    t = OxmlElement('w:t')
    t.text = '1'
    r.append(t)
    fld.append(r)
    p._p.append(fld)


def parse_table(lines, i):
    rows = []
    while i < len(lines) and lines[i].strip().startswith('|'):
        row = lines[i].strip().strip('|')
        cells = [c.strip() for c in row.split('|')]
        if not all(re.fullmatch(r':?-{2,}:?', c.replace(' ', '')) for c in cells):
            rows.append(cells)
        i += 1
    return rows, i


def _repeat_header(row):
    trPr = row._tr.get_or_add_trPr()
    tag = OxmlElement('w:tblHeader')
    tag.set(qn('w:val'), 'true')
    trPr.append(tag)


def _cant_split(row):
    trPr = row._tr.get_or_add_trPr()
    tag = OxmlElement('w:cantSplit')
    trPr.append(tag)


def add_table(doc, rows):
    if not rows:
        return
    cols = max(len(r) for r in rows)
    table = doc.add_table(rows=0, cols=cols)
    table.style = 'Table Grid'
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = True
    for ri, row in enumerate(rows):
        cells = table.add_row().cells
        _cant_split(table.rows[-1])
        if ri == 0:
            _repeat_header(table.rows[-1])
        for ci in range(cols):
            text = row[ci] if ci < len(row) else ''
            p = cells[ci].paragraphs[0]
            p.paragraph_format.space_after = Pt(1)
            add_inline(p, text, size=9, bold=(ri == 0))
            if ri == 0:
                for run in p.runs:
                    run.bold = True


def add_image(doc, path, alt):
    if not os.path.exists(path):
        return
    try:
        p = doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.add_run().add_picture(path, width=Cm(15.5))
        if alt:
            cap = doc.add_paragraph()
            cap.alignment = WD_ALIGN_PARAGRAPH.CENTER
            run = cap.add_run(alt)
            set_run_font(run, size=8.5, color=RGBColor(0x66, 0x66, 0x66))
    except Exception:
        pass


def render_markdown(doc, path, title, first=False):
    text = open(path, encoding='utf-8').read().replace('\r\n', '\n')
    lines = text.split('\n')
    base = os.path.dirname(path)
    if not first:
        doc.add_page_break()
    i = 0
    para = []

    def flush():
        nonlocal para
        if para:
            p = doc.add_paragraph()
            p.paragraph_format.space_after = Pt(4)
            p.paragraph_format.line_spacing = 1.25
            add_inline(p, ' '.join(para))
            para = []

    while i < len(lines):
        line = lines[i]
        stripped = line.strip()
        if stripped.startswith('```'):
            flush()
            i += 1
            code = []
            while i < len(lines) and not lines[i].strip().startswith('```'):
                code.append(lines[i])
                i += 1
            p = doc.add_paragraph()
            p.paragraph_format.space_before = Pt(3)
            p.paragraph_format.space_after = Pt(3)
            p.paragraph_format.line_spacing = 1.0
            for k, cl in enumerate(code):
                run = p.add_run(cl)
                set_run_font(run, size=8, mono=True)
                if k < len(code) - 1:
                    run.add_break()
            i += 1
            continue
        if stripped.startswith('|') and i + 1 < len(lines) and re.match(r'^\s*\|?[\s:-]+\|', lines[i + 1]):
            flush()
            rows, i = parse_table(lines, i)
            add_table(doc, rows)
            continue
        m = re.match(r'^(#{1,4})\s+(.*)$', stripped)
        if m:
            flush()
            level = len(m.group(1))
            heading = doc.add_heading(level=level)
            heading.paragraph_format.space_before = Pt(10 if level <= 2 else 6)
            heading.paragraph_format.space_after = Pt(4)
            add_inline(heading, m.group(2), size={1: 18, 2: 14, 3: 12, 4: 11}[level], bold=True)
            i += 1
            continue
        img = re.match(r'^!\[([^\]]*)\]\(([^)]+)\)', stripped)
        if img:
            flush()
            target = img.group(2).split('#')[0]
            add_image(doc, os.path.normpath(os.path.join(base, target)), img.group(1))
            i += 1
            continue
        if stripped.startswith('>'):
            flush()
            quote = stripped.lstrip('> ').strip()
            if '语言：' in quote or quote.startswith('Language:'):
                i += 1
                continue
            p = doc.add_paragraph()
            p.paragraph_format.left_indent = Cm(0.6)
            p.paragraph_format.space_after = Pt(2)
            add_inline(p, quote, size=9.5)
            for run in p.runs:
                run.italic = True
            i += 1
            continue
        if re.match(r'^[-*]\s+', stripped):
            flush()
            content = re.sub(r'^[-*]\s+', '', stripped)
            style = 'List Bullet 2' if line.startswith('  ') else 'List Bullet'
            p = doc.add_paragraph(style=style)
            p.paragraph_format.space_after = Pt(2)
            add_inline(p, content)
            i += 1
            continue
        if re.match(r'^\d+\.\s+', stripped):
            flush()
            p = doc.add_paragraph(style='List Number')
            p.paragraph_format.space_after = Pt(2)
            add_inline(p, re.sub(r'^\d+\.\s+', '', stripped))
            i += 1
            continue
        if stripped in ('---', '***'):
            flush()
            i += 1
            continue
        if stripped == '':
            flush()
            i += 1
            continue
        para.append(stripped)
        i += 1
    flush()


def build(docs, lang, title, subtitle, out_name):
    doc = Document()
    section = doc.sections[0]
    section.page_height = Cm(29.7)
    section.page_width = Cm(21)
    section.top_margin = Cm(2)
    section.bottom_margin = Cm(2)
    section.left_margin = Cm(2)
    section.right_margin = Cm(2)
    normal = doc.styles['Normal']
    normal.font.name = '微软雅黑'
    normal.font.size = Pt(10.5)
    normal.element.rPr.rFonts.set(qn('w:eastAsia'), '微软雅黑')
    add_page_number_footer(section, title)

    # cover
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_before = Pt(180)
    run = p.add_run(title)
    set_run_font(run, size=28, bold=True)
    p2 = doc.add_paragraph()
    p2.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = p2.add_run(subtitle)
    set_run_font(run, size=14)
    p3 = doc.add_paragraph()
    p3.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = p3.add_run('版本 2.4.0 · 2026-11-14 · MIT' if lang == 'zh' else 'Version 2.4.0 · 2026-11-14 · MIT')
    set_run_font(run, size=11, color=RGBColor(0x66, 0x66, 0x66))
    p4 = doc.add_paragraph()
    p4.alignment = WD_ALIGN_PARAGRAPH.CENTER
    note = ('本合集由仓库 docs/ 下的中文文档生成；截图敏感信息已打码。' if lang == 'zh'
            else 'Generated from the English documents under docs/; screenshots are redacted.')
    run = p4.add_run(note)
    set_run_font(run, size=9, color=RGBColor(0x88, 0x88, 0x88))

    # contents
    doc.add_page_break()
    h = doc.add_heading(level=1)
    add_inline(h, '目录' if lang == 'zh' else 'Contents', size=18, bold=True)
    for _, label in docs:
        p = doc.add_paragraph()
        p.paragraph_format.space_after = Pt(1)
        add_inline(p, label, size=10.5)

    for idx, (rel, label) in enumerate(docs):
        full = os.path.join(ROOT, rel)
        if os.path.exists(full):
            render_markdown(doc, full, label, first=False)

    out = os.path.join(OUT_DIR, out_name)
    doc.save(out)
    print('saved', out, os.path.getsize(out))


if __name__ == '__main__':
    build(ZH_DOCS, 'zh', 'dsh-superagent 多通道', '中文文档合集', 'dsh-superagent-multi-channel-docs-zh-CN.docx')
    build(EN_DOCS, 'en', 'dsh-superagent multi-channel', 'English documentation set', 'dsh-superagent-multi-channel-docs-en-US.docx')
