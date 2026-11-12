"""
HTML -> PDF.

templates/reports/report.html is rendered once and laid out by ReportLab (pdf_reportlab.py,
the default: pure Python, `pip install reportlab`) or by WeasyPrint (needs Pango). Both
produce the same design.

The template embeds every image as a data: URI and the only files it loads
are the bundled report fonts (report_generator/fonts: Fraunces, DM Sans,
DM Mono) plus DejaVu Sans from matplotlib as a symbol fallback. The URL
fetcher refuses everything else, so text in a report (location names, AI
output) can never make the renderer fetch a remote or local URL. The ReportLab
engine only ever reads embedded data: images and the same bundled fonts.
"""
import logging
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import url2pathname

import matplotlib
from django.template.loader import render_to_string

logger = logging.getLogger(__name__)

REPORT_FONT_DIR = (Path(__file__).resolve().parent / 'fonts').resolve()
FALLBACK_FONT_DIR = (Path(matplotlib.get_data_path()) / 'fonts' / 'ttf').resolve()
FONT_DIRS = (REPORT_FONT_DIR, FALLBACK_FONT_DIR)
FONTS = {
    'display_regular': REPORT_FONT_DIR / 'Fraunces-Regular.ttf',
    'display': REPORT_FONT_DIR / 'Fraunces-SemiBold.ttf',
    'display_italic': REPORT_FONT_DIR / 'Fraunces-Italic.ttf',
    'display_bold_italic': REPORT_FONT_DIR / 'Fraunces-SemiBoldItalic.ttf',
    'body': REPORT_FONT_DIR / 'DMSans-Regular.ttf',
    'body_italic': REPORT_FONT_DIR / 'DMSans-Italic.ttf',
    'body_bold': REPORT_FONT_DIR / 'DMSans-Bold.ttf',
    'mono': REPORT_FONT_DIR / 'DMMono-Regular.ttf',
    'mono_medium': REPORT_FONT_DIR / 'DMMono-Medium.ttf',
    'fallback': FALLBACK_FONT_DIR / 'DejaVuSans.ttf',
    'fallback_bold': FALLBACK_FONT_DIR / 'DejaVuSans-Bold.ttf',
}


class PDFRenderError(Exception):
    pass


def _make_fetcher():
    from weasyprint.urls import URLFetcher, URLFetchingError

    class LockedFetcher(URLFetcher):
        def fetch(self, url, headers=None):
            if url.startswith('data:'):
                return super().fetch(url, headers)
            parsed = urlparse(url)
            if parsed.scheme == 'file':
                path = Path(url2pathname(parsed.path)).resolve()  # handles Windows drive letters
                if path.parent in FONT_DIRS and path.suffix == '.ttf':
                    return super().fetch(url, headers)
            raise URLFetchingError(f'Blocked resource: {url[:80]}')

    return LockedFetcher()


def font_urls():
    return {name: path.as_uri() for name, path in FONTS.items() if path.exists()}


def _render_weasyprint(html):
    from weasyprint import HTML
    from weasyprint.text.fonts import FontConfiguration
    document = HTML(string=html, url_fetcher=_make_fetcher()).render(font_config=FontConfiguration())
    return document.write_pdf(), len(document.pages)


def _render_reportlab(html, context):
    from . import pdf_reportlab
    meta = context.get('meta') or {}
    return pdf_reportlab.render_html(html, {
        'generated': meta.get('generated_at_local', ''), 'platform': meta.get('platform', ''),
        'title': f"Business Intelligence Report – {meta.get('location_name', '')}",
    })


def pdf_engine():
    """'reportlab' (default: pure Python) or 'weasyprint' (needs the Pango system library)."""
    from django.conf import settings
    engine = str(getattr(settings, 'REPORT_PDF_ENGINE', 'reportlab')).strip().lower()
    return engine if engine in ('reportlab', 'weasyprint') else 'reportlab'


def render_pdf(context):
    """
    Render templates/reports/report.html to a PDF. Returns (pdf_bytes, page_count).

    Both engines lay out the same HTML with the same design, so the report looks the same
    either way. The configured engine (settings.REPORT_PDF_ENGINE) is tried first and the
    other one is the fallback.
    """
    html = render_to_string('reports/report.html', {**context, 'fonts': font_urls()})
    engines = {'reportlab': lambda: _render_reportlab(html, context), 'weasyprint': lambda: _render_weasyprint(html)}
    first = pdf_engine()
    second = 'weasyprint' if first == 'reportlab' else 'reportlab'
    try:
        return engines[first]()
    except Exception:
        logger.warning('%s could not render the report; trying %s', first, second, exc_info=True)
        return engines[second]()


def validate_pdf(pdf_bytes, required_phrases=()):
    """
    Structural check of the generated file: PDF signature, EOF marker, and
    (optionally) that the text layer contains the given phrases.
    """
    if not pdf_bytes or not pdf_bytes.startswith(b'%PDF-'):
        raise PDFRenderError('Generated file is not a PDF')
    if b'%%EOF' not in pdf_bytes[-1024:]:
        raise PDFRenderError('Generated PDF is truncated')
    if required_phrases:
        text = extract_text(pdf_bytes)
        missing = [p for p in required_phrases if p.lower() not in text.lower()]
        if missing:
            raise PDFRenderError(f'Generated PDF is missing expected content: {", ".join(missing)}')
    return True


def extract_text(pdf_bytes):
    """Text layer of the PDF, via pypdf (listed in requirements.txt)."""
    import io

    from pypdf import PdfReader
    reader = PdfReader(io.BytesIO(pdf_bytes))
    return '\n'.join((page.extract_text() or '') for page in reader.pages)
