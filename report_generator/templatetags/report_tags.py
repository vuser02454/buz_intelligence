import re

from django import template
from django.utils.html import escape
from django.utils.safestring import mark_safe

from report_generator import content

register = template.Library()


@register.filter
def inr(value):
    return content.inr(value)


@register.filter
def nice(value):
    return content.nice(value)


@register.filter
def pct(value, digits=0):
    if value is None:
        return '—'
    return content.pct(value, int(digits))


@register.filter
def level_word(value):
    return {1: 'Low', 2: 'Medium', 3: 'High'}.get(value, '—')


@register.filter
def get(mapping, key):
    try:
        return mapping.get(key)
    except AttributeError:
        return None


# Figures worth spotting at a glance: rupee amounts, percentages, scores and distances.
_FIGURE_RE = re.compile(
    r'(?:[-+]?₹\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:lakh|crore|k|L|Cr))?'
    r'|[-+]?\d+(?:\.\d+)?\s?%'
    r'|\d+(?:\.\d+)?\s?/\s?100'
    r'|\d[\d,]*(?:\.\d+)?\s?(?:km²|km|m)\b)'
)
# Decision terms a reader should not miss. Longer phrases come first so they win.
HIGHLIGHT_KEYWORDS = (
    'No-Go', 'Go', 'gross sales', 'footfall', 'revenue', 'profit', 'rent', 'competitors', 'competitor',
    'competition', 'demand', 'feasible', 'feasibility', 'synergy', 'high risk', 'risk', 'risks',
    'opportunity', 'opportunities', 'recommended', 'recommendation', 'strong', 'weak', 'validate',
    'licence', 'licences', 'estimate', 'estimates',
)
_KEYWORD_RE = re.compile(
    r'(?<![\w-])(' + '|'.join(re.escape(k) for k in sorted(HIGHLIGHT_KEYWORDS, key=len, reverse=True)) + r')(?![\w-])',
    re.IGNORECASE,
)
_TOKEN_RE = re.compile(f'({_FIGURE_RE.pattern})|{_KEYWORD_RE.pattern}', re.IGNORECASE)


@register.filter
def highlight(value):
    """Escape report text, then mark figures and key decision terms.

    The text is escaped before any markup is added, so AI output can never inject HTML.
    """
    if value is None:
        return ''
    text = str(escape(value))

    def mark(match):
        if match.group(1):
            return f'<mark class="hl-num">{match.group(0)}</mark>'
        word = match.group(0)
        # "Go" only counts as a verdict when capitalised; "go ahead" stays plain.
        if word.lower() == 'go' and word != 'Go':
            return word
        return f'<b class="hl-kw">{word}</b>'

    return mark_safe(_TOKEN_RE.sub(mark, text))
