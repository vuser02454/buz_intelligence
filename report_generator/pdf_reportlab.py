"""
Report HTML -> PDF with ReportLab (pure Python: `pip install reportlab`, no system libraries).

The report's content and design are defined once, in templates/reports/report.html and its
section templates. This module renders that same HTML and lays it out with ReportLab, following
the stylesheet in report.html: the editorial palette (report_generator/theme.py), the bundled
fonts (Fraunces, DM Sans, DM Mono), the navy cover, ivory / navy / royal-blue pages with running
header and footer, section openers, KPI cards, tables, callouts, figures and flowcharts.

It understands the HTML vocabulary those templates use (not arbitrary HTML/CSS). When a template
gains a new component, add its handling to `Builder.flow` / `Builder.inline`.
"""
import base64
import io
import re
from dataclasses import dataclass, replace
from html.parser import HTMLParser
from xml.sax.saxutils import escape

from reportlab.lib.colors import HexColor
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen.canvas import Canvas
from reportlab.platypus import (BaseDocTemplate, Flowable, Frame, Image, KeepTogether, NextPageTemplate, PageBreak,
                                PageTemplate, Paragraph, Spacer, Table, TableStyle)

from . import theme

PAGE_W, PAGE_H = A4
MARGIN_TOP, MARGIN_SIDE, MARGIN_BOTTOM = 24 * mm, 18 * mm, 22 * mm
CONTENT_W = PAGE_W - 2 * MARGIN_SIDE
CONTENT_H = PAGE_H - MARGIN_TOP - MARGIN_BOTTOM

IVORY, PAPER, NAVY, ROYAL, CHARCOAL, MUTED, LINE = (theme.IVORY, theme.PAPER, theme.NAVY, theme.ROYAL, theme.CHARCOAL,
                                                    theme.MUTED, theme.LINE)
PAGE_BG = {'ivory': IVORY, 'navy': NAVY, 'royal': ROYAL, 'cover': NAVY}
# running header / footer colours per page type: (left, right-top, right-bottom)
PAGE_CHROME = {'ivory': (MUTED, ROYAL, CHARCOAL), 'navy': ('#9AA6C8', IVORY, IVORY), 'royal': ('#C9D2F6', IVORY, IVORY)}

# (light page, dark page) text colour of the outlined provenance tags and pills
TAGS = {
    'tag-observed': (ROYAL, '#C9D2F6'), 'tag-estimate': ('#A0611A', '#F2C98A'), 'tag-ai': ('#6D3FD6', '#D8C8FF'),
    'tag-template': ('#5C5648', '#E4DFD4'), 'tag-user': ('#2F7D4B', '#A6E5BC'), 'tag-missing': ('#B33A3A', '#FFB4B4'),
    'pill-high': ('#B33A3A', '#FFB4B4'), 'pill-medium': ('#A0611A', '#F2C98A'), 'pill-low': ('#2F7D4B', '#A6E5BC'),
    'pill-empty': (MUTED, '#C3CBE6'), 'pill-yes': ('#2F7D4B', '#A6E5BC'), 'pill-no': ('#B33A3A', '#FFB4B4'),
}
TAG_BORDER = {
    'tag-observed': ROYAL, 'tag-estimate': '#C98A3A', 'tag-ai': '#8B5CF6', 'tag-template': '#A79F8D', 'tag-user': '#3E9B5F',
    'tag-missing': '#D64545', 'pill-high': '#D64545', 'pill-medium': '#E8962E', 'pill-low': '#3E9B5F', 'pill-empty': LINE,
    'pill-yes': '#3E9B5F', 'pill-no': '#D64545',
}
BOXES = {  # class: (left rule, background on ivory, (rule, rgb, alpha) on dark pages)
    'callout': (ROYAL, PAPER, (IVORY, IVORY, 0.08)),
    'warning': ('#D64545', '#FBF0EE', ('#FF9B9B', '#D64545', 0.18)),
    'note-box': ('#E8962E', '#FBF4E8', ('#F2B866', '#E8962E', 0.16)),
}
BREAK_BEFORE = {'sec-summary', 'sec-location', 'sec-revenue', 'sec-roadmap', 'sec-final', 'sec-appendix'}
BLOCK_TAGS = {'div', 'section', 'p', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'table', 'figure', 'figcaption', 'svg', 'img'}
FAMILY = {'sans': 'DMSans', 'serif': 'Fraunces', 'mono': 'DMMono'}


# ----------------------------------------------------------------------------- fonts
_fonts_ready = False


def register_fonts():
    """Register the bundled report fonts once per process."""
    global _fonts_ready
    if _fonts_ready:
        return
    from .pdf_generator import FONTS
    faces = {
        'DMSans': 'body', 'DMSans-Bold': 'body_bold', 'DMSans-Italic': 'body_italic',
        'Fraunces': 'display_regular', 'Fraunces-Bold': 'display', 'Fraunces-Italic': 'display_italic',
        'Fraunces-BoldItalic': 'display_bold_italic',
        'DMMono': 'mono', 'DMMono-Bold': 'mono_medium',
        'DejaVuSans': 'fallback', 'DejaVuSans-Bold': 'fallback_bold',
    }
    for name, key in faces.items():
        pdfmetrics.registerFont(TTFont(name, str(FONTS[key])))
    reg = pdfmetrics.registerFontFamily
    reg('DMSans', normal='DMSans', bold='DMSans-Bold', italic='DMSans-Italic', boldItalic='DMSans-Bold')
    reg('Fraunces', normal='Fraunces', bold='Fraunces-Bold', italic='Fraunces-Italic', boldItalic='Fraunces-BoldItalic')
    reg('DMMono', normal='DMMono', bold='DMMono-Bold', italic='DMMono', boldItalic='DMMono-Bold')
    reg('DejaVuSans', normal='DejaVuSans', bold='DejaVuSans-Bold', italic='DejaVuSans', boldItalic='DejaVuSans-Bold')
    _fonts_ready = True


def _has_glyph(font, ch):
    return ord(ch) in pdfmetrics.getFont(font).face.charToGlyph


def _font_for(ch, font):
    """The font that should draw `ch`: the requested one, else DM Sans (e.g. the rupee sign in mono), else DejaVu."""
    if ch.isspace() or _has_glyph(font, ch):
        return font
    if _has_glyph('DMSans', ch):
        return 'DMSans'
    return 'DejaVuSans'


# The bundled fonts have no colour emoji: use the matching text symbol (all in DejaVu Sans).
_SYMBOLS = {0x2705: '\u2713', 0x2714: '\u2713', 0x274C: '\u2717', 0x274E: '\u2717', 0x1F7E2: '\u25cf', 0x1F534: '\u25cf',
            0x1F7E0: '\u25cf', 0x1F7E1: '\u25cf', 0x2B50: '\u2605', 0x1F4CD: '\u25cf', 0xFE0F: None, 0x200D: None}


def _runs(text, font):
    """Split text into (font, chunk) runs so every character is drawn by a font that has it."""
    out = []
    for ch in text.translate(_SYMBOLS):
        f = _font_for(ch, font)
        if f == 'DejaVuSans' and not ch.isspace() and not _has_glyph(f, ch):
            continue            # no bundled font can draw it (e.g. an unmapped emoji): leave it out, not a blank box
        if out and out[-1][0] == f:
            out[-1][1] += ch
        else:
            out.append([f, ch])
    return out


def _blend(fg, bg, alpha):
    """Opaque equivalent of `fg` at `alpha` over `bg` (ReportLab table backgrounds are opaque)."""
    f, b = HexColor(fg), HexColor(bg)
    mix = lambda x, y: round((x * alpha + y * (1 - alpha)) * 255)
    return '#%02X%02X%02X' % (mix(f.red, b.red), mix(f.green, b.green), mix(f.blue, b.blue))


# ----------------------------------------------------------------------------- tiny DOM
class El:
    __slots__ = ('tag', 'attrs', 'kids', 'cls')

    def __init__(self, tag, attrs=None):
        self.tag, self.attrs, self.kids = tag, dict(attrs or {}), []
        self.cls = set((self.attrs.get('class') or '').split())

    def find(self, cls):
        for k in self.kids:
            if isinstance(k, El):
                if cls in k.cls:
                    return k
                hit = k.find(cls)
                if hit is not None:
                    return hit
        return None

    def all(self, cls):
        out = []
        for k in self.kids:
            if isinstance(k, El):
                if cls in k.cls:
                    out.append(k)
                else:
                    out.extend(k.all(cls))
        return out

    def els(self, tag=None):
        return [k for k in self.kids if isinstance(k, El) and (tag is None or k.tag == tag)]

    def text(self):
        return ''.join(k if isinstance(k, str) else k.text() for k in self.kids)


class _Parser(HTMLParser):
    VOID = {'br', 'img', 'meta', 'link', 'hr', 'col', 'rect', 'line', 'polygon', 'polyline', 'circle', 'path'}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = El('root')
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        el = El(tag, attrs)
        self.stack[-1].kids.append(el)
        if tag not in self.VOID:
            self.stack.append(el)

    def handle_startendtag(self, tag, attrs):
        self.stack[-1].kids.append(El(tag, attrs))

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                break

    def handle_data(self, data):
        self.stack[-1].kids.append(data)


def parse_body(html):
    start = html.find('<body')
    parser = _Parser()
    parser.feed(html[start:] if start >= 0 else html)
    body = next((k for k in parser.root.kids if isinstance(k, El) and k.tag == 'body'), parser.root)
    return body


def _is_block(node):
    return isinstance(node, El) and node.tag in BLOCK_TAGS


def _ws(text):
    return re.sub(r'[ \t\r\n\f]+', ' ', text)


# ----------------------------------------------------------------------------- inherited text context
@dataclass(frozen=True)
class Cx:
    family: str = 'sans'
    size: float = 9.4
    lh: float = 1.6             # line-height multiplier
    color: str = CHARCOAL
    strong: str = NAVY          # colour of <strong>
    bold: bool = False
    italic: bool = False
    upper: bool = False
    dark: bool = False          # on a navy / royal page
    bg: str = IVORY             # colour behind the text (for blending translucent boxes)
    align: int = TA_LEFT
    width: float = CONTENT_W    # available width
    grid: bool = False          # inside a .step .grid column
    toc: bool = False
    step: bool = False

    @property
    def muted(self):
        return '#C3CBE6' if self.dark else MUTED

    @property
    def accent(self):
        return '#C9D2F6' if self.dark else ROYAL

    @property
    def hair(self):
        return _blend(IVORY, self.bg, 0.22) if self.dark else LINE

    @property
    def rule(self):
        return IVORY if self.dark else NAVY


# ----------------------------------------------------------------------------- custom flowables
class SpacedText(Flowable):
    """Plain text with letter-spacing (small uppercase mono labels); Paragraph cannot letter-space."""

    def __init__(self, text, font, size, color, spacing_em=0.12, leading=None, align=TA_LEFT, space_after=0):
        super().__init__()
        self.text, self.font, self.size, self.color = text, font, size, color
        self.cs = spacing_em * size
        self.leading = leading or size * 1.45
        self.align, self.spaceAfter = align, space_after
        self.lines = []

    def _w(self, s):
        return sum(stringWidth(chunk, f, self.size) for f, chunk in _runs(s, self.font)) + self.cs * len(s)

    def min_width(self):
        return max((self._w(w) for w in self.text.split()), default=0)

    def pref_width(self):
        return self._w(self.text)

    def wrap(self, aw, ah):
        words, lines, cur = self.text.split(), [], ''
        for w in words:
            trial = (cur + ' ' + w) if cur else w
            if cur and self._w(trial) > aw + 0.01:
                lines.append(cur)
                cur = w
            else:
                cur = trial
        if cur:
            lines.append(cur)
        self.lines, self.width = lines, aw
        self.height = self.leading * max(1, len(lines))
        return aw, self.height

    def draw(self):
        c = self.canv
        y = self.height - self.size * 1.05
        for line in self.lines:
            w = self._w(line) - self.cs
            x = 0 if self.align == TA_LEFT else (self.width - w if self.align == TA_RIGHT else (self.width - w) / 2)
            t = c.beginText(x, y)
            t.setFillColor(HexColor(self.color))
            t.setCharSpace(self.cs)
            for f, chunk in _runs(line, self.font):
                t.setFont(f, self.size)
                t.textOut(chunk)
            t.setCharSpace(0)
            c.drawText(t)
            y -= self.leading


class Rule(Flowable):
    def __init__(self, color, thickness=0.5, space_before=0, space_after=0):
        super().__init__()
        self.color, self.thickness, self.spaceBefore, self.spaceAfter = color, thickness, space_before, space_after

    def wrap(self, aw, ah):
        self.width = aw
        return aw, self.thickness

    def draw(self):
        self.canv.setStrokeColor(HexColor(self.color))
        self.canv.setLineWidth(self.thickness)
        self.canv.line(0, 0, self.width, 0)


class SectionHead(Flowable):
    """Section opener: hairline, small numbered mono label with a short rule, large serif title."""

    def __init__(self, num, title, cx, anchor, running):
        super().__init__()
        self.num, self.title, self.cx, self.anchor, self.running = num, title, cx, anchor, running
        self.spaceBefore, self.spaceAfter, self.keepWithNext = 0, 6 * mm, True
        self.top = 10 * mm

    def wrap(self, aw, ah):
        self.width = aw
        _, th = self.title.wrap(aw, ah)
        self.th = th
        self.inner = 4 * mm + 7.4 * 1.3 + 3 * mm + th
        self.height = self.top + self.inner
        return aw, self.height

    def draw(self):
        c, cx = self.canv, self.cx
        doc = c._doctemplate
        page = c.getPageNumber()
        doc.anchors[self.anchor] = page
        doc.page_section.setdefault(page, self.running)
        doc.current_section = self.running
        c.bookmarkPage(self.anchor)
        c.addOutlineEntry(self.running, self.anchor, level=0)
        c.setLineWidth(0.5)
        c.setStrokeColor(HexColor(_blend(IVORY, cx.bg, 0.28) if cx.dark else LINE))
        c.line(0, self.inner, self.width, self.inner)
        y = self.inner - 4 * mm - 7.4
        c.setStrokeColor(HexColor(cx.accent))
        c.setLineWidth(1)
        c.line(0, y + 2.6, 6 * mm, y + 2.6)
        t = c.beginText(9 * mm, y)
        t.setFont('DMMono-Bold', 7.4)
        t.setCharSpace(0.16 * 7.4)
        t.setFillColor(HexColor(cx.accent))
        t.textOut(self.num)
        t.setCharSpace(0)
        c.drawText(t)
        self.title.drawOn(c, 0, 0)


class Anchor(Flowable):
    """Zero-height marker that records the page an id lands on (for the contents page)."""

    def __init__(self, name):
        super().__init__()
        self.name = name

    def wrap(self, aw, ah):
        return 0, 0

    def draw(self):
        self.canv._doctemplate.anchors[self.name] = self.canv.getPageNumber()


class Svg(Flowable):
    """Draws the flowcharts produced by flowchart_generator (rect, line, polygon, polyline, text)."""

    def __init__(self, el, width):
        super().__init__()
        vb = [float(v) for v in (el.attrs.get('viewbox') or el.attrs.get('viewBox') or '0 0 100 100').split()]
        self.el, self.vw, self.vh = el, vb[2], vb[3]
        self.scale = width / self.vw
        self.width, self.height = width, self.vh * self.scale
        self.hAlign = 'CENTER'

    def wrap(self, aw, ah):
        return self.width, self.height

    def _paint(self, a):
        c = self.canv
        fill, stroke = a.get('fill'), a.get('stroke')
        has_fill = bool(fill) and fill != 'none'
        has_stroke = bool(stroke) and stroke != 'none'
        if has_fill:
            c.setFillColor(HexColor(fill))
        if has_stroke:
            c.setStrokeColor(HexColor(stroke))
            c.setLineWidth(float(a.get('stroke-width', 1)) * self.scale)
        return has_fill, has_stroke

    def draw(self):
        c, s, H = self.canv, self.scale, self.height
        num = lambda a, k, d=0.0: float(a.get(k, d))
        for el in self.el.kids:
            if not isinstance(el, El):
                continue
            a = el.attrs
            c.saveState()
            if el.tag == 'rect':
                fill, stroke = self._paint(a)
                x, y, w, h = num(a, 'x') * s, num(a, 'y') * s, num(a, 'width') * s, num(a, 'height') * s
                c.roundRect(x, H - y - h, w, h, num(a, 'rx') * s, stroke=int(stroke), fill=int(fill))
            elif el.tag == 'line':
                self._paint(a)
                c.line(num(a, 'x1') * s, H - num(a, 'y1') * s, num(a, 'x2') * s, H - num(a, 'y2') * s)
            elif el.tag in ('polygon', 'polyline'):
                fill, stroke = self._paint(a)
                pts = [float(v) for v in re.split(r'[ ,]+', (a.get('points') or '').strip()) if v]
                if len(pts) >= 4:
                    p = c.beginPath()
                    p.moveTo(pts[0] * s, H - pts[1] * s)
                    for i in range(2, len(pts) - 1, 2):
                        p.lineTo(pts[i] * s, H - pts[i + 1] * s)
                    if el.tag == 'polygon':
                        p.close()
                    c.drawPath(p, stroke=int(stroke), fill=int(fill and el.tag == 'polygon'))
            elif el.tag == 'text':
                bold = a.get('font-weight') == 'bold'
                mono = 'Mono' in (a.get('font-family') or '')
                font = ('DMMono-Bold' if bold else 'DMMono') if mono else ('DMSans-Bold' if bold else 'DMSans')
                size = num(a, 'font-size', 12) * s
                runs = _runs(el.text(), font)
                width = sum(stringWidth(chunk, f, size) for f, chunk in runs)
                x = num(a, 'x') * s
                anchor = a.get('text-anchor', 'start')
                x -= width if anchor == 'end' else (width / 2 if anchor == 'middle' else 0)
                t = c.beginText(x, H - num(a, 'y') * s)
                t.setFillColor(HexColor(a.get('fill') or CHARCOAL))
                for f, chunk in runs:
                    t.setFont(f, size)
                    t.textOut(chunk)
                c.drawText(t)
            c.restoreState()


class Cover(Flowable):
    """The navy cover page, drawn from the .cover section of the HTML."""

    def __init__(self, el, builder):
        super().__init__()
        self.el, self.b = el, builder

    def wrap(self, aw, ah):
        return aw, ah

    def _spaced(self, x, y, text, size, color, em, font='DMMono'):
        t = self.canv.beginText(x, y)
        t.setCharSpace(em * size)
        t.setFillColor(HexColor(color))
        for f, chunk in _runs(text, font):
            t.setFont(f, size)
            t.textOut(chunk)
        t.setCharSpace(0)
        self.canv.drawText(t)

    def draw(self):
        c, b, el = self.canv, self.b, self.el
        cx = Cx(color=IVORY, strong=IVORY, dark=True, bg=NAVY)
        left, width = 20 * mm, PAGE_W - 40 * mm
        y = PAGE_H - 33 * mm
        brand = el.find('brand')
        if brand is not None:
            c.setStrokeColor(HexColor(ROYAL))
            c.setLineWidth(1)
            c.line(left, y + 2.6, left + 6 * mm, y + 2.6)
            self._spaced(left + 9 * mm, y, _ws(brand.text()).strip().upper(), 7.4, '#9AA6C8', 0.22)
        y -= 26 * mm
        h1 = next(iter(el.find('cover-band').els('h1')), None) if el.find('cover-band') is not None else None
        if h1 is not None:
            p = b.para([h1], replace(cx, family='serif', size=50, lh=1.02), raw=_ws(h1.text()).strip())
            _, h = p.wrap(150 * mm, PAGE_H)
            y -= h
            p.drawOn(c, left, y)
        sub = el.find('subtitle')
        if sub is not None:
            y -= 7 * mm
            p = b.para(sub.kids, replace(cx, family='serif', italic=True, size=19, lh=1.25, color='#C9D2F6'))
            _, h = p.wrap(width, PAGE_H)
            y -= h
            p.drawOn(c, left, y)
        y -= 18 * mm
        c.setStrokeColor(HexColor('#34446E'))
        c.setLineWidth(0.5)
        c.line(left, y, left + width, y)
        y -= 10 * mm
        items, col_w, gap_x, gap_y = el.all('cover-item'), 75 * mm, 10 * mm, 8 * mm
        for i in range(0, len(items), 2):
            row_h = 0
            for j, item in enumerate(items[i:i + 2]):
                x, yy = left + j * (col_w + gap_x), y
                c.line(x, yy, x + col_w, yy)
                yy -= 2.5 * mm + 8
                label = item.find('label')
                if label is not None:
                    self._spaced(x, yy, _ws(label.text()).strip().upper(), 6.6, '#7F8DB8', 0.18)
                yy -= 2.4 * mm
                value = item.find('value')
                if value is not None:
                    p = b.para(value.kids, replace(cx, size=12, lh=1.6))
                    _, h = p.wrap(col_w, PAGE_H)
                    yy -= h
                    p.drawOn(c, x, yy)
                meta = item.find('meta')
                if meta is not None and _ws(meta.text()).strip():
                    p = b.para(meta.kids, replace(cx, family='mono', size=7, lh=1.4, color='#7F8DB8'))
                    _, h = p.wrap(col_w, PAGE_H)
                    yy -= 0.8 * mm + h
                    p.drawOn(c, x, yy)
                row_h = max(row_h, y - yy)
            y -= row_h + gap_y
        foot = el.find('cover-foot')
        if foot is not None:
            p = b.para(foot.kids, replace(cx, family='mono', size=6.8, lh=1.7, color='#9AA6C8'))
            _, h = p.wrap(width, PAGE_H)
            base = 16 * mm
            p.drawOn(c, left, base)
            c.line(left, base + h + 4 * mm, left + width, base + h + 4 * mm)


# ----------------------------------------------------------------------------- canvas + document
class ReportCanvas(Canvas):
    """Canvas with the two inline callbacks that draw the outline around tags and pills."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.setNamedCB('tagOpen', self._tag_open)
        self.setNamedCB('tagClose', self._tag_close)
        self._tag_start = None

    def _tag_open(self, canvas, kind, label):
        info = self._curr_tx_info
        self._tag_start = (info['cur_x'], info['cur_y'])

    def _tag_close(self, canvas, kind, label):
        if not self._tag_start:
            return
        color, size = label.split('|')
        size = float(size)
        info = self._curr_tx_info
        x0, y0 = self._tag_start
        self._tag_start = None
        if abs(info['cur_y'] - y0) > 0.01 or info['cur_x'] <= x0:     # wrapped: no box
            return
        self.saveState()
        self.setStrokeColor(HexColor(color))
        self.setLineWidth(0.5)
        self.rect(x0, y0 - size * 0.45, info['cur_x'] - x0, size * 1.62, stroke=1, fill=0)
        self.restoreState()


class ReportDoc(BaseDocTemplate):
    def __init__(self, buffer, meta, total_pages=None):
        super().__init__(buffer, pagesize=A4, leftMargin=MARGIN_SIDE, rightMargin=MARGIN_SIDE, topMargin=MARGIN_TOP,
                         bottomMargin=MARGIN_BOTTOM, title=meta.get('title', 'Business Intelligence Report'),
                         author=meta.get('platform', ''), subject='Location analysis')
        self.meta, self.total_pages = meta, total_pages
        self.anchors, self.page_section, self.current_section, self._carried = {}, {}, '', ''
        body = lambda: Frame(MARGIN_SIDE, MARGIN_BOTTOM, CONTENT_W, CONTENT_H, leftPadding=0, rightPadding=0, topPadding=0,
                             bottomPadding=0, id='body')
        full = Frame(0, 0, PAGE_W, PAGE_H, leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0, id='cover')
        self.addPageTemplates([
            PageTemplate(id='cover', frames=[full], onPage=self._background),
            PageTemplate(id='ivory', frames=[body()], onPage=self._background, onPageEnd=self._chrome),
            PageTemplate(id='navy', frames=[body()], onPage=self._background, onPageEnd=self._chrome),
            PageTemplate(id='royal', frames=[body()], onPage=self._background, onPageEnd=self._chrome),
        ])

    def _background(self, canvas, doc):
        canvas.saveState()
        canvas.setFillColor(HexColor(PAGE_BG[doc.pageTemplate.id]))
        canvas.rect(0, 0, PAGE_W, PAGE_H, stroke=0, fill=1)
        canvas.restoreState()

    def _chrome(self, canvas, doc):
        """Running header and footer, drawn at page end so the page's own section title is known."""
        left_c, top_c, bottom_c = PAGE_CHROME[doc.pageTemplate.id]
        page = canvas.getPageNumber()
        section = self.page_section.get(page, self._carried)
        self._carried = self.current_section

        def text(x, y, s, size, color, em, right=False):
            runs = _runs(s, 'DMMono')
            if right:
                x -= sum(stringWidth(chunk, f, size) for f, chunk in runs) + em * size * max(0, len(s) - 1)
            t = canvas.beginText(x, y)
            t.setCharSpace(em * size)
            t.setFillColor(HexColor(color))
            for f, chunk in runs:
                t.setFont(f, size)
                t.textOut(chunk)
            t.setCharSpace(0)
            canvas.drawText(t)

        canvas.saveState()
        top = PAGE_H - MARGIN_TOP + 4 * mm + 1.6
        bottom = MARGIN_BOTTOM - 5 * mm - 5.4
        text(MARGIN_SIDE, top, f"BUSINESS INTELLIGENCE REPORT · {self.meta.get('locname', '')}".upper(), 6.6, left_c, 0.08)
        text(PAGE_W - MARGIN_SIDE, top, section.upper(), 6.6, top_c, 0.08, right=True)
        text(MARGIN_SIDE, bottom, f"Generated {self.meta.get('generated', '')} · Estimates, not guarantees", 6.4, left_c, 0)
        total = self.total_pages or '?'
        text(PAGE_W - MARGIN_SIDE, bottom, f'Page {page} of {total}', 6.6, bottom_c, 0.06, right=True)
        canvas.restoreState()


# ----------------------------------------------------------------------------- HTML -> flowables
class Builder:
    def __init__(self, toc_pages=None):
        self.toc_pages = toc_pages or {}
        self.template, self.fresh = 'cover', True
        self._styles = {}
        self.locname = ''

    # ---- paragraphs -------------------------------------------------------
    def style(self, cx, before=0, after=0, indent=0, bullet_indent=0, keep=False):
        key = (cx.family, cx.size, cx.lh, cx.color, cx.align, before, after, indent, bullet_indent, keep)
        st = self._styles.get(key)
        if st is None:
            st = ParagraphStyle(
                f's{len(self._styles)}', fontName=FAMILY[cx.family], fontSize=cx.size, leading=cx.size * cx.lh,
                textColor=HexColor(cx.color), alignment=cx.align, spaceBefore=before, spaceAfter=after, leftIndent=indent,
                bulletIndent=bullet_indent, keepWithNext=int(keep), splitLongWords=1, allowWidows=0, allowOrphans=0,
                bulletFontName='DMSans', bulletFontSize=cx.size, bulletColor=HexColor(cx.accent))
            self._styles[key] = st
        return st

    def txt(self, text, cx):
        """Escaped text for a Paragraph, with characters the font lacks handed to a fallback font."""
        if cx.upper:
            text = text.upper()
        base = FAMILY[cx.family]
        out = []
        for font, chunk in _runs(text, base):
            chunk = escape(chunk)
            out.append(chunk if font == base else f'<font name="{font}">{chunk}</font>')
        return ''.join(out)

    def inline(self, nodes, cx):
        """ReportLab paragraph markup for a run of inline nodes."""
        out = []
        for n in nodes:
            if isinstance(n, str):
                out.append(self.txt(_ws(n), cx))
                continue
            t, c = n.tag, n.cls
            if t == 'br':
                out.append('<br/>')
            elif t in ('strong', 'b') and cx.grid and t == 'strong':
                out.append(f'<font name="DMMono-Bold" size="6.4" color="{cx.accent}">'
                           f'{self.txt(_ws(n.text()), replace(cx, family="mono", upper=True))}</font>')
            elif t == 'b' and 'hl-kw' in c:
                inner = self.inline(n.kids, cx)
                if cx.dark:
                    out.append(f'<font color="#FFFFFF"><u color="#C9D2F6"><b>{inner}</b></u></font>')
                else:
                    out.append(f'<font color="{ROYAL}"><b>{inner}</b></font>')
            elif t in ('strong', 'b'):
                out.append(f'<font color="{cx.strong}"><b>{self.inline(n.kids, cx)}</b></font>')
            elif t in ('em', 'i'):
                out.append(f'<i>{self.inline(n.kids, cx)}</i>')
            elif t == 'mark':
                bg = '#F2C98A' if cx.dark else '#FCE7A8'
                out.append(f'<font backcolor="{bg}" color="{NAVY}"><b>{self.inline(n.kids, cx)}</b></font>')
            elif t == 'code':
                inner = self.inline(n.kids, replace(cx, family='mono'))
                out.append(f'<font name="DMMono" size="{cx.size * 0.9:.2f}" color="{cx.accent}">{inner}</font>')
            elif t == 'a':
                out.append(f'<font color="{cx.accent}">{self.inline(n.kids, cx)}</font>')
            elif t == 'span' and ('tag' in c or 'pill' in c):
                kind = next((k for k in c if k in TAGS), 'tag-template')
                light, dark = TAGS[kind]
                color = dark if cx.dark else light
                border = color if cx.dark else TAG_BORDER[kind]
                size = 6.2 if 'tag' in c else 6.4
                label = self.txt('\u00a0' + _ws(n.text()).strip().replace(' ', '\u00a0') + '\u00a0',
                                 replace(cx, family='mono', upper=True))
                out.append(f' <onDraw name="tagOpen" label="x"/><font name="DMMono-Bold" size="{size}" color="{color}">'
                           f'{label}</font><onDraw name="tagClose" label="{border}|{size}"/> ')
            elif t == 'span' and 'swatch' in c:
                m = re.search(r'background:\s*(#[0-9a-fA-F]{3,6})', n.attrs.get('style', ''))
                out.append(f'<font name="DejaVuSans" color="{m.group(1) if m else cx.color}">●</font> ')
            elif t == 'span':
                sub = cx
                if 'muted' in c:
                    sub = replace(sub, color=cx.muted)
                inner = self.inline(n.kids, sub)
                if 'small' in c:
                    inner = f'<font size="8.1">{inner}</font>'
                if 'muted' in c:
                    inner = f'<font color="{cx.muted}">{inner}</font>'
                if 'unavailable' in c:
                    inner = f'<font color="{"#FFB4B4" if cx.dark else "#B33A3A"}"><i>{inner}</i></font>'
                out.append(inner)
            else:
                out.append(self.inline(n.kids, cx))
        return ''.join(out)

    def para(self, nodes, cx, before=0, after=0, indent=0, bullet=None, keep=False, raw=None):
        body = self.txt(raw, cx) if raw is not None else self.inline(nodes, cx)
        body = re.sub(r'^(\s|&nbsp;)+|\s+$', '', re.sub(r' {2,}', ' ', body))
        if cx.bold:
            body = f'<b>{body}</b>'
        if cx.italic:
            body = f'<i>{body}</i>'
        st = self.style(cx, before, after, indent, max(0, indent - (2.4 * mm if bullet == '•' else 4.4 * mm)) if bullet else 0, keep)
        return Paragraph(body or '&nbsp;', st, bulletText=bullet)

    # ---- page flow --------------------------------------------------------
    def brk(self, template):
        if self.fresh and self.template == template:
            return []
        self.template, self.fresh = template, True
        return [NextPageTemplate(template), PageBreak()]

    def page_cx(self, template, width=CONTENT_W):
        if template in ('navy', 'royal'):
            return Cx(color=IVORY, strong=IVORY, dark=True, bg=PAGE_BG[template], width=width)
        return Cx(width=width)

    def build(self, body):
        story = []
        for node in body.kids:
            if not isinstance(node, El):
                continue
            if 'cover' in node.cls:
                loc = node.find('locname')
                self.locname = _ws(loc.text()).strip() if loc is not None else ''
                story.append(Cover(node, self))
                self.fresh = False
                story += self.brk('ivory')
            elif 'pg-navy' in node.cls or 'pg-royal' in node.cls:
                template = 'navy' if 'pg-navy' in node.cls else 'royal'
                story += self.brk(template)
                story += self.children(node, self.page_cx(template))
                story += self.brk('ivory')
            else:
                if 'toc' in node.cls:
                    story += self.brk('ivory')
                story += self.flow(node, self.page_cx('ivory'))
        while story and isinstance(story[-1], (PageBreak, NextPageTemplate)):
            story.pop()
        return story

    def children(self, el, cx):
        """Flowables for an element's children; consecutive inline nodes become one paragraph."""
        out, run = [], []

        def flush():
            if any((isinstance(r, El)) or r.strip() for r in run):
                out.append(self.para(run, cx, after=1 * mm))
                self.fresh = False
            run.clear()

        for k in el.kids:
            if _is_block(k):
                flush()
                out.extend(self.flow(k, cx))
            else:
                run.append(k)
        flush()
        return out

    def flow(self, el, cx):
        t, c, out = el.tag, el.cls, []
        if el.attrs.get('id') in BREAK_BEFORE:
            out += self.brk(self.template)
        handler = getattr(self, f'_{t}', None)
        if 'toc' in c:
            cx = replace(cx, toc=True)
        if 'small' in c:
            cx = replace(cx, size=8.1)
        if 'muted' in c:
            cx = replace(cx, color=cx.muted)
        if t == 'div':
            out += self._div(el, cx)
        elif handler:
            out += handler(el, cx)
        else:
            out += self.children(el, cx)
        if out:
            self.fresh = isinstance(out[-1], PageBreak)
        return out

    # ---- headings & text ---------------------------------------------------
    def _h1(self, el, cx):
        return [self.para(el.kids, replace(cx, family='serif', size=34, lh=1.15, color=cx.strong), after=6 * mm)]

    def _h2(self, el, cx):
        hcx = replace(cx, family='serif', lh=1.15, color=cx.strong)
        if 'section' not in el.cls:
            return [self.para(el.kids, replace(hcx, size=34 if cx.toc else 27), before=4 * mm, after=10 * mm, keep=True)]
        num = el.find('num')
        num_text = _ws(num.text()).strip() if num is not None else ''
        rest = [k for k in el.kids if k is not num]
        title_text = _ws(''.join(k if isinstance(k, str) else k.text() for k in rest)).replace('\u00a0', ' ').strip()
        title = self.para(rest, replace(hcx, size=27))
        running = f'{num_text} {title_text}'.strip()
        return [SectionHead(num_text, title, cx, el.attrs.get('id') or running, running)]

    def _h3(self, el, cx):
        return [self.para(el.kids, replace(cx, family='serif', size=15, lh=1.15, color=cx.strong), before=8 * mm, after=2.5 * mm,
                          keep=True)]

    def _h4(self, el, cx):
        before, after = (0, 1.2 * mm) if cx.step else (5 * mm, 1.5 * mm)
        return [self.para(el.kids, replace(cx, family='serif', italic=True, size=11.5, lh=1.15, color=cx.strong), before=before,
                          after=after, keep=True)]

    def _p(self, el, cx):
        if 'statement' in el.cls:
            return [self.para(el.kids, replace(cx, family='serif', italic=True, size=16, lh=1.35, color=cx.strong), after=2 * mm)]
        if 'unavailable' in el.cls:
            cx = replace(cx, italic=True, color='#FFB4B4' if cx.dark else '#B33A3A')
        if cx.toc:
            cx = replace(cx, size=9, lh=2)
        return [self.para(el.kids, cx, after=1.2 * mm if cx.step else 3 * mm)]

    def _figcaption(self, el, cx):
        return [self.para(el.kids, replace(cx, size=7.8, lh=1.5, color=cx.muted), before=2.5 * mm)]

    def _img(self, el, cx):
        return self._image(el, cx)

    def _svg(self, el, cx):
        return [Svg(el, min(122 * mm, cx.width))]

    def _section(self, el, cx):
        return self.children(el, cx)

    # ---- lists --------------------------------------------------------------
    def _ul(self, el, cx):
        if 'checklist' in el.cls:
            return self._checklist(el, cx)
        return self._list(el, cx, ordered=False)

    def _ol(self, el, cx):
        if cx.toc:
            return self._toc_list(el, cx)
        return self._list(el, cx, ordered=True)

    def _list(self, el, cx, ordered):
        out, items = [], el.els('li')
        gap = 0.3 * mm if cx.step else 1.2 * mm
        for i, li in enumerate(items):
            inline = [k for k in li.kids if not _is_block(k)]
            blocks = [k for k in li.kids if _is_block(k)]
            last = i == len(items) - 1
            bullet = f'{i + 1}.' if ordered else '•'
            after = (1 * mm if cx.step else 3.5 * mm) if last and not blocks else gap
            out.append(self.para(inline, cx, after=after, indent=5 * mm, bullet=bullet))
            for b in blocks:
                sub = self.flow(b, replace(cx, width=cx.width - 5 * mm))
                out.append(_indent(sub, 5 * mm, cx.width))
        return out

    def _checklist(self, el, cx):
        rows = []
        for li in el.els('li'):
            box = Paragraph(f'<font name="DejaVuSans" size="10" color="{IVORY if cx.dark else ROYAL}">☐</font>', self.style(cx))
            rows.append([box, self.para(li.kids, cx)])
        if not rows:
            return []
        t = Table(rows, colWidths=[7 * mm, cx.width - 7 * mm])
        t.setStyle(TableStyle([
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'), ('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (-1, -1), 0),
            ('TOPPADDING', (0, 0), (-1, -1), 1.6 * mm), ('BOTTOMPADDING', (0, 0), (-1, -1), 1.6 * mm),
            ('LINEBELOW', (0, 0), (-1, -1), 0.5, HexColor(cx.hair)),
        ]))
        t.spaceAfter = 3.5 * mm
        return [t]

    def _toc_list(self, el, cx):
        rows = []
        for li in el.els('li'):
            a = next(iter(li.els('a')), None)
            target = (a.attrs.get('href') or '').lstrip('#') if a is not None else ''
            label = SpacedText(_ws(li.text()).strip().upper(), 'DMMono', 8.6, CHARCOAL, 0.04)
            page = SpacedText(str(self.toc_pages.get(target, '')), 'DMMono', 8.6, ROYAL, 0.04, align=TA_RIGHT)
            rows.append([label, page])
        t = Table(rows, colWidths=[cx.width - 16 * mm, 16 * mm])
        t.setStyle(TableStyle([
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'), ('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (-1, -1), 0),
            ('TOPPADDING', (0, 0), (-1, -1), 2.6 * mm), ('BOTTOMPADDING', (0, 0), (-1, -1), 2.6 * mm),
            ('LINEABOVE', (0, 0), (-1, 0), 0.5, HexColor(NAVY)), ('LINEBELOW', (0, 0), (-1, -1), 0.5, HexColor(LINE)),
        ]))
        t.spaceAfter = 12 * mm
        return [t]

    # ---- divs ---------------------------------------------------------------
    def _div(self, el, cx):
        c = el.cls
        if 'kpis' in c:
            return self._kpis(el, cx)
        if 'keypoints' in c:
            return self._keypoints(el, cx)
        for name in BOXES:
            if name in c:
                return self._box(el, cx, name)
        if 'two-col' in c:
            return self._columns(el.els('div'), cx, gap=8 * mm)
        if 'grid' in c:
            return self._columns(el.els('div'), replace(cx, size=7.8, grid=True), gap=5 * mm, after=1 * mm)
        if 'step' in c:
            return self._step(el, cx)
        if 'legend' in c:
            return [self.para(el.kids, replace(cx, family='mono', size=6.8, lh=1.5, upper=True, align=TA_CENTER,
                                               color=CHARCOAL if not cx.dark else cx.color), before=2 * mm)]
        if 'label' in c and not any(isinstance(k, El) for k in el.kids):
            return [SpacedText(_ws(el.text()).strip().upper(), 'DMMono-Bold', 6.8, cx.accent, 0.16, space_after=2 * mm)]
        return self.children(el, cx)

    def _kpis(self, el, cx):
        cards = el.all('kpi')
        col, gap = 54 * mm, 4 * mm
        per_row = max(1, min(3, int((cx.width + gap) // (col + gap))))
        rows, style = [], [
            ('VALIGN', (0, 0), (-1, -1), 'TOP'), ('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (-1, -1), 0),
            ('TOPPADDING', (0, 0), (-1, -1), 3 * mm), ('BOTTOMPADDING', (0, 0), (-1, -1), 4 * mm),
        ]
        for r in range(0, len(cards), per_row):
            row = []
            for j, card in enumerate(cards[r:r + per_row]):
                cell = []
                label, value, note = card.find('label'), card.find('value'), card.find('note')
                if label is not None:
                    cell.append(SpacedText(_ws(label.text()).strip().upper(), 'DMMono', 6.4, '#C9D2F6' if cx.dark else MUTED, 0.14))
                if value is not None:
                    cell.append(self.para(value.kids, replace(cx, family='serif', size=19, lh=1.15, color=cx.strong),
                                          before=1 * mm, after=2.4 * mm))
                if note is not None:
                    cell.append(self.para(note.kids, replace(cx, family='mono', size=6.6, lh=1.5,
                                                             color='#C9D2F6' if cx.dark else MUTED)))
                row += [cell, '']
                style.append(('LINEABOVE', (2 * j, len(rows)), (2 * j, len(rows)), 1, HexColor(cx.rule)))
            row += [''] * (2 * per_row - len(row))
            rows.append(row[:2 * per_row - 1])
        t = Table(rows, colWidths=([col, gap] * per_row)[:-1], hAlign='LEFT')
        t.setStyle(TableStyle(style))
        t.spaceBefore, t.spaceAfter = 4 * mm, 3 * mm
        return [t]

    def _boxed(self, content, width, style, before=4 * mm, after=4 * mm):
        """Wrap flowables in a single-cell table (background / rules). Too tall to fit a page: leave unboxed."""
        if not content:
            return []
        if _height(content, width) > CONTENT_H * 0.8:
            return content
        t = Table([[content]], colWidths=[width])
        t.setStyle(TableStyle(style))
        t.spaceBefore, t.spaceAfter = before, after
        return [t]

    def _box(self, el, cx, name):
        rule, bg, dark = BOXES[name]
        if cx.dark:
            rule, bg = dark[0], _blend(dark[1], cx.bg, dark[2])
        pad_x, pad_y = 5 * mm, 3.5 * mm
        inner = replace(cx, bg=bg, width=cx.width - 2 * pad_x)
        content = self.children(el, inner)
        return self._boxed(content, cx.width, [
            ('BACKGROUND', (0, 0), (-1, -1), HexColor(bg)), ('LINEBEFORE', (0, 0), (0, -1), 1.5, HexColor(rule)),
            ('LEFTPADDING', (0, 0), (-1, -1), pad_x), ('RIGHTPADDING', (0, 0), (-1, -1), pad_x),
            ('TOPPADDING', (0, 0), (-1, -1), pad_y), ('BOTTOMPADDING', (0, 0), (-1, -1), pad_y - 1 * mm),
        ])

    def _keypoints(self, el, cx):
        # always a light card with dark text, also on the royal summary page
        inner = Cx(size=cx.size, bg=PAPER, width=cx.width - 10 * mm)
        return self._boxed(self.children(el, inner), cx.width, [
            ('BACKGROUND', (0, 0), (-1, -1), HexColor(PAPER)), ('BOX', (0, 0), (-1, -1), 1, HexColor(ROYAL)),
            ('LEFTPADDING', (0, 0), (-1, -1), 5 * mm), ('RIGHTPADDING', (0, 0), (-1, -1), 5 * mm),
            ('TOPPADDING', (0, 0), (-1, -1), 4 * mm), ('BOTTOMPADDING', (0, 0), (-1, -1), 2 * mm),
        ], before=2 * mm, after=6 * mm)

    def _columns(self, cols, cx, gap, after=3 * mm):
        if not cols:
            return []
        n = len(cols)
        w = (cx.width - gap * (n - 1)) / n
        cells = [self.children(col, replace(cx, width=w)) or [Spacer(0, 0)] for col in cols]
        if max(_height(cell, w) for cell in cells) > CONTENT_H * 0.8:
            return [f for cell in cells for f in cell]
        row, widths = [], []
        for i, cell in enumerate(cells):
            row.append(cell)
            widths.append(w)
            if i < n - 1:
                row.append('')
                widths.append(gap)
        t = Table([row], colWidths=widths)
        t.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'TOP'), ('LEFTPADDING', (0, 0), (-1, -1), 0),
                               ('RIGHTPADDING', (0, 0), (-1, -1), 0), ('TOPPADDING', (0, 0), (-1, -1), 0),
                               ('BOTTOMPADDING', (0, 0), (-1, -1), 0)]))
        t.spaceAfter = after
        return [t]

    def _step(self, el, cx):
        inner = replace(cx, size=8.1, lh=1.5, step=True)
        return self._boxed(self.children(el, inner), cx.width, [
            ('LINEABOVE', (0, 0), (-1, 0), 0.5, HexColor(cx.rule)), ('LEFTPADDING', (0, 0), (-1, -1), 0),
            ('RIGHTPADDING', (0, 0), (-1, -1), 0), ('TOPPADDING', (0, 0), (-1, -1), 2.8 * mm),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 1.5 * mm),
        ], before=0, after=2.5 * mm)

    # ---- figures ------------------------------------------------------------
    def _image(self, el, cx, max_h=None):
        src = el.attrs.get('src', '')
        if not src.startswith('data:image') or ',' not in src:
            return []           # like the WeasyPrint fetcher: only embedded images, never a URL
        try:
            raw = base64.b64decode(src.split(',', 1)[1])
            iw, ih = ImageReader(io.BytesIO(raw)).getSize()
        except Exception:
            return []
        is_map = 'map' in el.cls
        m = re.search(r'max-height:\s*([\d.]+)mm', el.attrs.get('style', ''))
        limit_h = float(m.group(1)) * mm if m else (max_h or (108 * mm if is_map else 74 * mm))
        pad = 2.5 * mm if is_map else 0
        w = min(cx.width - 2 * pad, iw * 0.75)
        h = w * ih / iw
        if h > limit_h:
            h = limit_h
            w = h * iw / ih
        img = Image(io.BytesIO(raw), width=w, height=h)
        img.hAlign = 'CENTER'
        if not is_map:
            return [img]
        t = Table([[img]], colWidths=[w + 2 * pad], hAlign='CENTER')
        t.setStyle(TableStyle([('BACKGROUND', (0, 0), (-1, -1), HexColor(PAPER)), ('BOX', (0, 0), (-1, -1), 0.5, HexColor(NAVY)),
                               ('LEFTPADDING', (0, 0), (-1, -1), pad), ('RIGHTPADDING', (0, 0), (-1, -1), pad),
                               ('TOPPADDING', (0, 0), (-1, -1), pad), ('BOTTOMPADDING', (0, 0), (-1, -1), pad)]))
        return [t]

    def _figure(self, el, cx):
        if 'flow' in el.cls:
            pad_x = 5 * mm
            inner = Cx(bg=PAPER, width=cx.width - 2 * pad_x)       # flowcharts keep their light card on dark pages
            content = []
            for k in el.els():
                if k.tag == 'figcaption':
                    content.append(Rule(LINE, 0.5, space_before=4 * mm))
                    content.extend(self._figcaption(k, inner))
                else:
                    content.extend(self.flow(k, inner))
            style = [('BACKGROUND', (0, 0), (-1, -1), HexColor(PAPER)), ('LEFTPADDING', (0, 0), (-1, -1), pad_x),
                     ('RIGHTPADDING', (0, 0), (-1, -1), pad_x), ('TOPPADDING', (0, 0), (-1, -1), 6 * mm),
                     ('BOTTOMPADDING', (0, 0), (-1, -1), 4 * mm)]
            if not cx.dark:
                style.append(('BOX', (0, 0), (-1, -1), 0.5, HexColor(LINE)))
            return self._boxed(content, cx.width, style, before=5 * mm, after=6 * mm)
        content = []
        for k in el.kids:
            if _is_block(k):
                content.extend(self.flow(k, cx))
        if not content:
            return []
        # margins as flowable spacing (not Spacers), so they collapse at the top of a page like CSS margins
        content[0].spaceBefore, content[-1].spaceAfter = 5 * mm, 6 * mm
        return [KeepTogether(content)]

    # ---- tables -------------------------------------------------------------
    def _table(self, el, cx):
        head_rows = [tr for th in el.els('thead') for tr in th.els('tr')]
        body_rows = [tr for tb in el.els('tbody') for tr in tb.els('tr')] + el.els('tr')
        rows = head_rows + body_rows
        if not rows:
            return []
        n_cols = max(len([k for k in tr.els() if k.tag in ('td', 'th')]) for tr in rows)
        pad_x, pad_y = 2 * mm, 1.8 * mm
        data, mins, prefs, fixed = [], [0.0] * n_cols, [0.0] * n_cols, [None] * n_cols
        style = [('VALIGN', (0, 0), (-1, -1), 'TOP'), ('LEFTPADDING', (0, 0), (-1, -1), pad_x),
                 ('RIGHTPADDING', (0, 0), (-1, -1), pad_x), ('TOPPADDING', (0, 0), (-1, -1), pad_y),
                 ('BOTTOMPADDING', (0, 0), (-1, -1), pad_y)]
        for r, tr in enumerate(rows):
            is_head = r < len(head_rows)
            row = []
            for ci, cell in enumerate([k for k in tr.els() if k.tag in ('td', 'th')][:n_cols]):
                num = 'num' in cell.cls
                plain = _ws(cell.text()).strip()
                m = re.search(r'width:\s*([\d.]+)mm', cell.attrs.get('style', ''))
                if m:
                    fixed[ci] = float(m.group(1)) * mm
                if cell.tag == 'th':
                    color = (cx.accent if is_head else cx.muted)
                    flow = [SpacedText(plain.upper(), 'DMMono-Bold', 6.6, color, 0.12, align=TA_RIGHT if num else TA_LEFT)]
                    lo, hi = flow[0].min_width(), flow[0].pref_width()
                else:
                    ccx = replace(cx, size=8.1 if 'small' in cell.cls else 8.3, lh=1.6, width=cx.width / max(1, n_cols))
                    if num:
                        ccx = replace(ccx, family='mono', size=8, align=TA_RIGHT)
                    if any(_is_block(k) for k in cell.kids):
                        flow = self.children(cell, ccx)
                    else:
                        flow = [self.para(cell.kids, ccx)]
                    font = FAMILY[ccx.family]
                    hi = stringWidth(plain, font, ccx.size) * 1.04
                    lo = hi if num else max((stringWidth(w, font, ccx.size) for w in plain.split()), default=0) * 1.04
                mins[ci] = max(mins[ci], lo + 2 * pad_x + 1)
                prefs[ci] = max(prefs[ci], hi + 2 * pad_x + 1)
                row.append(flow)
            row += [''] * (n_cols - len(row))
            data.append(row)
            line = (1, cx.rule) if is_head else (0.5, cx.hair)
            style.append(('LINEBELOW', (0, r), (-1, r), line[0], HexColor(line[1])))
        widths = _column_widths(mins, prefs, fixed, cx.width)
        t = Table(data, colWidths=widths, repeatRows=len(head_rows), hAlign='LEFT')
        t.setStyle(TableStyle(style))
        t.spaceBefore, t.spaceAfter = 3 * mm, 5 * mm
        return [t]


def _height(flowables, width):
    total = 0
    for f in flowables:
        _, h = f.wrap(width, 10 ** 6)
        total += h + f.getSpaceBefore() + f.getSpaceAfter()
    return total


def _indent(flowables, left, width):
    t = Table([[flowables]], colWidths=[width - left])
    t.setStyle(TableStyle([('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (-1, -1), 0),
                           ('TOPPADDING', (0, 0), (-1, -1), 0), ('BOTTOMPADDING', (0, 0), (-1, -1), 0)]))
    t.hAlign = 'RIGHT'
    return t


def _column_widths(mins, prefs, fixed, total):
    """Approximation of HTML auto table layout: fixed columns first, the rest between min and preferred width."""
    n = len(mins)
    widths = [0.0] * n
    free = [i for i in range(n) if fixed[i] is None]
    for i in range(n):
        if fixed[i] is not None:
            widths[i] = min(max(fixed[i], prefs[i]), total * 0.45)
    room = total - sum(widths)
    if not free:
        scale = total / max(1.0, sum(widths))
        return [w * scale for w in widths]
    cap = room * 0.62
    pref = {i: min(max(prefs[i], mins[i]), max(cap, mins[i])) for i in free}
    lo = {i: min(mins[i], pref[i]) for i in free}
    sum_pref, sum_lo = sum(pref.values()), sum(lo.values())
    if sum_pref <= room:
        extra = room - sum_pref
        for i in free:
            widths[i] = pref[i] + extra * pref[i] / max(1.0, sum_pref)
    elif sum_lo >= room:
        for i in free:
            widths[i] = lo[i] * room / sum_lo
    else:
        k = (room - sum_lo) / (sum_pref - sum_lo)
        for i in free:
            widths[i] = lo[i] + (pref[i] - lo[i]) * k
    return widths


# ----------------------------------------------------------------------------- entry point
def _render_once(body, meta, toc_pages, total_pages):
    builder = Builder(toc_pages)
    story = builder.build(body)
    buffer = io.BytesIO()
    doc = ReportDoc(buffer, {**meta, 'locname': builder.locname}, total_pages)
    doc.build(story, canvasmaker=ReportCanvas)
    return buffer.getvalue(), doc.page, dict(doc.anchors)


def render_html(html, meta=None):
    """
    Lay out the report HTML as a PDF. Returns (pdf_bytes, page_count).

    Two passes: the first finds the page count and the page each section starts on, the second
    prints them ("Page 3 of 32", the contents page). A third runs only if that changed the layout.
    """
    register_fonts()
    body = parse_body(html)
    meta = meta or {}
    pdf, pages, anchors = _render_once(body, meta, {}, None)
    for _ in range(2):
        pdf, pages2, anchors2 = _render_once(body, meta, anchors, pages)
        if pages2 == pages and anchors2 == anchors:
            break
        pages, anchors = pages2, anchors2
    return pdf, pages
