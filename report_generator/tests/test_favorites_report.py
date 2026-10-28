"""Bug 8: 'Download All Favorites Report' and the Generated Business Reports list."""
import json
from unittest.mock import patch

from django.db import DatabaseError
from django.test import TestCase, override_settings

from favorites import store
from report_generator.models import Report
from report_generator.pdf_generator import extract_text

from .fixtures import LAT, LON, auth_header, fake_overpass, signed_in

EXPORT = '/api/favorites/report/'
FAVORITES = [
    {'id': 11, 'place_key': 'osm:node:1', 'name': 'Shop and save', 'category': 'convenience', 'latitude': LAT, 'longitude': LON,
     'address': 'Uttarahalli Main Road', 'potential_score': 82, 'created_at': '2026-10-28T10:00:00+00:00'},
    {'id': 12, 'place_key': 'osm:node:2', 'name': 'Reliance Fresh', 'category': 'supermarket', 'latitude': LAT + 0.004,
     'longitude': LON + 0.003, 'address': '', 'potential_score': 69, 'created_at': '2026-10-28T09:00:00+00:00'},
    {'id': 13, 'place_key': 'osm:node:3', 'name': 'Prarthana School', 'category': 'school', 'latitude': LAT - 0.003,
     'longitude': LON + 0.002, 'address': '', 'potential_score': 84, 'created_at': '2026-10-28T08:00:00+00:00'},
    {'id': 14, 'place_key': 'osm:node:4', 'name': 'Bangalore International Public School', 'category': 'school',
     'latitude': LAT + 0.002, 'longitude': LON - 0.004, 'address': '', 'potential_score': 82, 'created_at': '2026-10-28T07:00:00+00:00'},
]


@override_settings(REPORT_RUN_INLINE=True, REPORT_AI_ENABLED=False, REPORT_MAX_PER_HOUR=10, REPORT_MAX_CONCURRENT=2)
class FavoritesReportTests(TestCase):
    def export(self, body=None, favorites=FAVORITES, user='user-aaaaaaaa-1111'):
        with signed_in(user), fake_overpass(), patch('favorites.store.list_favorites', return_value=favorites):
            return self.client.post(EXPORT, json.dumps(body or {}), content_type='application/json', **auth_header())

    def get(self, url, user='user-aaaaaaaa-1111'):
        with signed_in(user):
            return self.client.get(url, **auth_header())

    def test_full_detail_pdf_for_every_favorite_and_listed_in_reports(self):
        resp = self.export()
        self.assertEqual(resp.status_code, 202, resp.content)
        rid = resp.json()['report_id']
        status = self.get(f'/api/reports/{rid}/status/').json()
        self.assertEqual(status['status'], 'succeeded', status)
        self.assertEqual(status['kind'], 'favorites')

        pdf = self.get(f'/api/reports/{rid}/download/')
        self.assertEqual(pdf.status_code, 200)
        text = ' '.join(extract_text(pdf.content).split())
        for f in FAVORITES:
            self.assertIn(f['name'], text)
        for section in ('Comparison of saved places', 'Location and crowd density', 'Popular places nearby',
                        'Revenue estimate', 'Competitor analysis', 'Feasibility', 'SWOT', 'Strengths', 'Threats', 'Key risks'):
            self.assertIn(section, text)
        self.assertTrue('GO' in text or 'NO-GO' in text)

        listed = self.get('/api/reports/').json()['reports']
        self.assertEqual(listed[0]['id'], rid)
        self.assertEqual(listed[0]['kind'], 'favorites')
        self.assertTrue(listed[0]['has_pdf'])
        self.assertIn('4 places', listed[0]['location_name'])

    def test_only_selected_favorites_are_analysed(self):
        resp = self.export({'ids': [12, 13]})
        self.assertEqual(resp.status_code, 202, resp.content)
        report = Report.objects.get(id=resp.json()['report_id'])
        self.assertEqual([p['name'] for p in report.places], ['Reliance Fresh', 'Prarthana School'])

    def test_reportlab_fallback_still_has_full_detail(self):
        with patch('weasyprint.HTML', side_effect=OSError('cannot load library pango')):
            resp = self.export({'ids': [11, 12]})
        rid = resp.json()['report_id']
        self.assertEqual(self.get(f'/api/reports/{rid}/status/').json()['status'], 'succeeded')
        text = ' '.join(extract_text(self.get(f'/api/reports/{rid}/download/').content).split())
        for needle in ('Favorites Comparison Report', 'Shop and save', 'Reliance Fresh', 'SWOT', 'Feasibility (Go / No-Go)', '₹'):
            self.assertIn(needle, text)

    def test_errors_are_json_with_clear_messages(self):
        self.assertEqual(self.export(favorites=[]).json()['code'], 'no_favorites')
        self.assertEqual(self.export({'ids': 'x'}).status_code, 400)
        with signed_in(), patch('favorites.store.list_favorites', side_effect=store.StoreError(401, 'JWT expired')):
            resp = self.client.post(EXPORT, '{}', content_type='application/json', **auth_header())
        self.assertEqual(resp.status_code, 401)
        self.assertIn('sign in', resp.json()['error'].lower())
        self.assertEqual(self.client.post(EXPORT, '{}', content_type='application/json').status_code, 401)

    def test_old_get_export_is_gone(self):
        with signed_in():
            self.assertEqual(self.client.get(EXPORT, **auth_header()).status_code, 405)

    def test_overpass_down_for_all_places_fails_cleanly(self):
        with signed_in(), fake_overpass(error='HTTP 502'), patch('favorites.store.list_favorites', return_value=FAVORITES[:2]):
            resp = self.client.post(EXPORT, '{}', content_type='application/json', **auth_header())
        status = self.get(f"/api/reports/{resp.json()['report_id']}/status/").json()
        self.assertEqual(status['status'], 'failed')
        self.assertIn('OpenStreetMap', status['error'])


class ReportListTests(TestCase):
    def test_database_problem_returns_json_not_html(self):
        with signed_in(), patch('report_generator.views.Report.objects.filter', side_effect=DatabaseError('no such table')):
            resp = self.client.get('/api/reports/', **auth_header())
        self.assertEqual(resp.status_code, 503)
        self.assertEqual(resp['Content-Type'], 'application/json')
        self.assertIn('migrate', resp.json()['error'])
