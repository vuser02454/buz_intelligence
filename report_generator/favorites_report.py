"""
Full-detail PDF for several saved favorites (Report.kind == 'favorites').

Each place gets the same analysis as a single-location report
(data_collector.collect_analysis on the shared cached 5 km area data) plus its
popular places, a SWOT built from those numbers, the risk register, the
Go/No-Go reasons and a server-drawn heatmap. A comparison table ranks the
places side by side. Rendered with WeasyPrint, falling back to ReportLab.
"""
import io
import logging

from django.template.loader import render_to_string

from business_intelligence import analysis, utils
from business_intelligence.prediction_engine.config import BUSINESS_METRICS

from . import chart_generator, content
from .data_collector import CollectionError, collect_analysis
from .pdf_generator import _make_fetcher, font_urls

logger = logging.getLogger(__name__)

MAX_PLACES = 6
# OSM categories saved with favorites -> a business category the engines model.
_CATEGORY_ALIASES = {
    'convenience': 'supermarket', 'grocery': 'supermarket', 'chemist': 'pharmacy', 'coffee_shop': 'cafe',
    'bar': 'restaurant', 'pub': 'restaurant', 'food_court': 'restaurant', 'bakery': 'cafe',
}


def business_for_category(category):
    """Engine business type for a saved place's OSM category ('' -> let the ML model choose)."""
    key = str(category or '').strip().lower().replace(' ', '_')
    key = _CATEGORY_ALIASES.get(key, key)
    if key in BUSINESS_METRICS:
        return key
    choices = {c for values in analysis.get_all_business_choices().values() for c in values}
    return key if key in choices else ''


def popular_places(lat, lon, limit=8):
    """Named businesses spread over the 5 km circle with revenue-engine estimates (same as the map)."""
    fetched = analysis.fetch_area_pois(lat, lon, analysis.HEATMAP_RADIUS_M, wait_s=90)
    if fetched['status'] != 'ok':
        return []
    elements = analysis.elements_within(fetched['elements'], lat, lon, analysis.HEATMAP_RADIUS_M)
    targets = analysis.sample_places_across_sectors(elements, lat, lon, analysis.HEATMAP_RADIUS_M, limit=limit)
    enriched, _total = utils.enrich_places_with_revenue(elements, targets=targets)
    rows = []
    for p in enriched[:limit]:
        tags = p.get('tags') or {}
        rd = p.get('revenue_data') or {}
        rows.append({
            'name': tags.get('name') or 'Unnamed',
            'type': content.nice(tags.get('amenity') or tags.get('shop') or tags.get('tourism') or ''),
            'distance_km': round((p.get('distance_m') or 0) / 1000, 1),
            'monthly': rd.get('estimated_monthly_revenue'),
            'potential': rd.get('potential_score'),
        })
    return rows


def swot(s):
    """Strengths / weaknesses / opportunities / threats, each sentence built from the snapshot's numbers."""
    heat, rev, comp, feas, rec, pois = (s.get(k) or {} for k in ('heatmap', 'revenue', 'competition', 'feasibility',
                                                                   'recommendation', 'pois'))
    S, W, O, T = [], [], [], []
    if not heat.get('placeholder_used'):
        counts = heat.get('counts') or {}
        level = heat.get('dominant')
        (S if level in ('high', 'medium') else W).append(
            f"Overall density of mapped places is {level} ({heat.get('density_per_km2', 0)}/km²; "
            f"{counts.get('high', 0)} high, {counts.get('medium', 0)} medium, {counts.get('low', 0)} low sectors).")
    if pois.get('status') == 'ok':
        (S if pois['in_radius'] >= 300 else W).append(f"{pois['in_radius']:,} mapped places within 5 km.")
    if rev.get('status') == 'ok':
        score = rev['potential_score']
        (S if score >= 60 else W).append(f"Revenue-engine potential score {score}/100 for {content.nice(rev['business_type'])}.")
        S.extend(rev.get('positive_factors', [])[:2])
        W.extend(rev.get('negative_factors', [])[:2])
        if rev.get('uses_default_assumptions'):
            W.append('Revenue engine used generic assumptions for this category.')
    if feas.get('status') == 'ok':
        (S if feas['feasible'] else W).append("Platform feasibility rules: " + ('Go.' if feas['feasible'] else 'No-Go.'))
    if comp.get('status') == 'ok':
        if comp['within_1000_m'] == 0:
            O.append('No same-category competitor mapped within 1 km – possible unserved demand (verify on site).')
        elif comp['within_1000_m'] >= 10:
            T.append(f"{comp['within_1000_m']} same-category competitors within 1 km.")
        else:
            O.append(f"Moderate competition: {comp['within_1000_m']} similar places within 1 km.")
    if rec.get('status') == 'ok':
        O.append(f"ML model suggests {content.nice(rec['primary'])} for this area"
                 + (f"; alternatives: {', '.join(content.nice(a['business']) for a in rec.get('alternatives') or [])}." if rec.get('alternatives') else '.'))
    T.append('Rent and operating costs are unknown to the platform.')
    T.append('Footfall is inferred from mapped places, not counted.')
    none = ['None identified from the available data.']
    return {'strengths': S or none, 'weaknesses': W or none, 'opportunities': O or none, 'threats': T}


def analyse_place(place):
    """Full analysis for one saved place; on failure the place is kept with the reason."""
    business = business_for_category(place.get('category'))
    base = {'place': place, 'business_requested': business}
    try:
        s = collect_analysis(place['latitude'], place['longitude'], place['name'], analysis.HEATMAP_RADIUS_M, business)
    except CollectionError as exc:
        return {**base, 'status': 'unavailable', 'reason': str(exc)}
    feas = s.get('feasibility') or {}
    return {
        **base,
        'status': 'ok',
        's': s,
        'popular': popular_places(place['latitude'], place['longitude']),
        'swot': swot(s),
        'risks': content.risk_register(s)[:5],
        'reasons': analysis.feasibility_reasons(feas) if feas.get('status') == 'ok' else [],
        'map': chart_generator.sector_map_chart(s),
    }


def comparison_rows(results):
    rows = []
    for r in results:
        if r['status'] != 'ok':
            rows.append({'name': r['place']['name'], 'unavailable': True, 'reason': r['reason']})
            continue
        s = r['s']
        rev, comp, feas, heat = (s.get(k) or {} for k in ('revenue', 'competition', 'feasibility', 'heatmap'))
        rows.append({
            'name': r['place']['name'],
            'business': content.nice(s.get('target_business')),
            'crowd': heat.get('dominant', '—'),
            'density': heat.get('density_per_km2'),
            'places': (s.get('pois') or {}).get('in_radius', 0),
            'monthly': rev.get('monthly') if rev.get('status') == 'ok' else None,
            'potential': rev.get('potential_score') if rev.get('status') == 'ok' else None,
            'competitors_1km': comp.get('within_1000_m') if comp.get('status') == 'ok' else None,
            'verdict': ('Go' if feas.get('feasible') else 'No-Go') if feas.get('status') == 'ok' else '—',
        })
    ranked = sorted([r for r in rows if not r.get('unavailable') and r['potential'] is not None],
                    key=lambda r: r['potential'], reverse=True)
    for i, r in enumerate(ranked, 1):
        r['rank'] = i
    return rows


def build_context(report, results, generated_at_local):
    return {
        'meta': {'title': report.location_name, 'generated_at_local': generated_at_local,
                 'reference': str(report.id)[:8].upper(), 'count': len(results)},
        'results': results,
        'comparison': comparison_rows(results),
        'fonts': font_urls(),
    }


def render(context):
    """WeasyPrint first; ReportLab when the system libraries (Pango) are missing. Returns (pdf, pages)."""
    try:
        from weasyprint import HTML
        from weasyprint.text.fonts import FontConfiguration
        html = render_to_string('reports/favorites_report.html', context)
        document = HTML(string=html, url_fetcher=_make_fetcher()).render(font_config=FontConfiguration())
        return document.write_pdf(), len(document.pages)
    except Exception:
        logger.warning('WeasyPrint unavailable for the favorites report; using ReportLab', exc_info=True)
        return render_reportlab(context)


def render_reportlab(context):
    from pypdf import PdfReader
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.platypus import Image, PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
    from xml.sax.saxutils import escape

    from .pdf_generator import FONTS

    font, bold = 'Helvetica', 'Helvetica-Bold'
    try:  # DejaVu has the ₹ glyph and Indic-safe fallback; Helvetica does not.
        pdfmetrics.registerFont(TTFont('RptSans', str(FONTS['fallback'])))
        pdfmetrics.registerFont(TTFont('RptSans-Bold', str(FONTS['fallback_bold'])))
        font, bold = 'RptSans', 'RptSans-Bold'
    except Exception:
        pass
    ss = getSampleStyleSheet()
    h1 = ParagraphStyle('h1', parent=ss['Heading1'], fontName=bold, fontSize=18, leading=22)
    h2 = ParagraphStyle('h2', parent=ss['Heading2'], fontName=bold, fontSize=13, leading=16, textColor=colors.HexColor('#1e40af'))
    h3 = ParagraphStyle('h3', parent=ss['Heading3'], fontName=bold, fontSize=10.5, leading=13)
    body = ParagraphStyle('b', parent=ss['Normal'], fontName=font, fontSize=8.5, leading=12)
    P = lambda t, st=body: Paragraph(escape(str(t)), st)

    def table(rows, widths=None):
        t = Table([[P(c) for c in r] for r in rows], colWidths=widths, repeatRows=1)
        t.setStyle(TableStyle([('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#e2e8f0')),
                               ('GRID', (0, 0), (-1, -1), 0.4, colors.HexColor('#cbd5e1')),
                               ('VALIGN', (0, 0), (-1, -1), 'TOP')]))
        return t

    meta = context['meta']
    story = [P('Favorites Comparison Report', h1),
             P(f"{meta['count']} saved places · generated {meta['generated_at_local']} · ref {meta['reference']}"),
             Spacer(1, 10), P('Comparison of saved places', h2)]
    comp = [['#', 'Place', 'Business', 'Crowd', 'Mapped places', 'Est. revenue / month', 'Potential', 'Competitors ≤1 km', 'Verdict']]
    for r in context['comparison']:
        if r.get('unavailable'):
            comp.append(['—', r['name'], 'Data unavailable', '', '', '', '', '', ''])
        else:
            comp.append([r.get('rank', '—'), r['name'], r['business'], r['crowd'], r['places'], content.inr(r['monthly']),
                         r['potential'] if r['potential'] is not None else '—', r['competitors_1km'] if r['competitors_1km'] is not None else '—', r['verdict']])
    story.append(table(comp))
    for r in context['results']:
        place = r['place']
        story += [PageBreak(), P(place['name'], h2),
                  P(f"{place.get('address') or ''} ({place['latitude']:.5f}, {place['longitude']:.5f}) · saved category: {content.nice(place.get('category')) or '—'}")]
        if r['status'] != 'ok':
            story.append(P('Analysis unavailable: ' + r['reason']))
            continue
        s = r['s']
        heat, rev, comp_d, feas = (s.get(k) or {} for k in ('heatmap', 'revenue', 'competition', 'feasibility'))
        story.append(P('Crowd density and heatmap', h3))
        story.append(P(f"Dominant level {heat.get('dominant')}, {heat.get('density_per_km2')} mapped places/km²; "
                       f"sectors: {heat['counts']['high']} high, {heat['counts']['medium']} medium, {heat['counts']['low']} low, {heat['counts']['empty']} empty."))
        if r.get('map'):
            import base64
            story.append(Image(io.BytesIO(base64.b64decode(r['map'].split(',', 1)[1])), width=260, height=260))
        story.append(P('Popular places nearby', h3))
        story.append(table([['Place', 'Type', 'Distance', 'Est. revenue / month']] +
                           [[p['name'], p['type'], f"{p['distance_km']} km", content.inr(p['monthly'])] for p in r['popular']] or [['—', '', '', '']]))
        story.append(P('Revenue estimate', h3))
        story.append(P(f"{content.nice(rev.get('business_type'))}: {content.inr(rev.get('monthly'))} per month "
                       f"(range {content.inr((rev.get('range') or {}).get('min'))}–{content.inr((rev.get('range') or {}).get('max'))}), "
                       f"potential {rev.get('potential_score')}/100." if rev.get('status') == 'ok' else 'Revenue estimate unavailable.'))
        story.append(P('Competitor analysis', h3))
        story.append(P(f"{comp_d.get('count', 0)} competitors within 5 km, {comp_d.get('within_1000_m', 0)} within 1 km, nearest {comp_d.get('nearest_m') or '—'} m."
                       if comp_d.get('status') == 'ok' else 'Competitor data unavailable.'))
        story.append(P('Feasibility (Go / No-Go)', h3))
        story.append(P(('GO' if feas.get('feasible') else 'NO-GO') + ' – ' + feas.get('message', '') if feas.get('status') == 'ok' else 'Unavailable.'))
        for reason in r['reasons']:
            story.append(P('• ' + reason))
        story.append(P('SWOT', h3))
        sw = r['swot']
        story.append(table([['Strengths', 'Weaknesses'], ['\n'.join(sw['strengths']), '\n'.join(sw['weaknesses'])],
                            ['Opportunities', 'Threats'], ['\n'.join(sw['opportunities']), '\n'.join(sw['threats'])]]))
        story.append(P('Key risks', h3))
        story.append(table([['Risk', 'Likelihood × impact', 'Mitigation']] +
                           [[k['risk'], f"{k['likelihood']} × {k['impact']}", k['mitigation']] for k in r['risks']]))
    buf = io.BytesIO()
    SimpleDocTemplate(buf, pagesize=A4, leftMargin=36, rightMargin=36, topMargin=36, bottomMargin=36,
                      title='Favorites Comparison Report').build(story)
    pdf = buf.getvalue()
    return pdf, len(PdfReader(io.BytesIO(pdf)).pages)
