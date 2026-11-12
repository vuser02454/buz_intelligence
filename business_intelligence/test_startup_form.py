"""Bug 10: the startup form saves the inquiry, runs the feasibility check and tells the page where to go."""
from unittest.mock import patch

from django.test import TestCase

from business_intelligence.models import BusinessUser
from report_generator.tests.fixtures import LAT, LON, fake_overpass

URL = '/submit-form/'


def form(**overrides):
    data = {'name': 'Rajan', 'email': 'rajan@example.com', 'phone': '1234567890', 'business_type': 'Cafe',
            'crowd_intensity': 'medium', 'latitude': str(LAT), 'longitude': str(LON),
            'location_name': 'Uttarahalli, Bengaluru'}
    data.update(overrides)
    return data


class StartupFormTests(TestCase):
    def test_saves_inquiry_and_returns_verdict_and_map_target(self):
        with fake_overpass():
            resp = self.client.post(URL, form())
        self.assertEqual(resp.status_code, 200, resp.content)
        data = resp.json()
        self.assertTrue(data['success'])
        inquiry = BusinessUser.objects.get(id=data['inquiry_id'])
        self.assertEqual((inquiry.name, inquiry.business_type, inquiry.crowd_intensity), ('Rajan', 'Cafe', 'medium'))
        self.assertAlmostEqual(inquiry.latitude, LAT)
        f = data['feasibility']
        self.assertEqual(f['status'], 'ok')
        self.assertIn(f['verdict'], ('Go', 'No-Go'))
        self.assertTrue(f['reasons'])
        self.assertEqual(f['desired_intensity'], 'medium')
        self.assertIn('crowd level', f['intensity_note'])
        self.assertEqual(data['redirect'], {'latitude': LAT, 'longitude': LON, 'name': 'Uttarahalli, Bengaluru',
                                            'business_type': 'Cafe', 'crowd_intensity': 'medium'})

    def test_inquiry_is_saved_even_when_map_data_is_not_ready(self):
        with patch('business_intelligence.views.fetch_area_pois',
                   return_value={'status': 'pending', 'retry_after': 4, 'error': 'still fetching'}):
            data = self.client.post(URL, form()).json()
        self.assertTrue(data['success'])
        self.assertEqual(data['feasibility']['status'], 'pending')
        self.assertEqual(BusinessUser.objects.count(), 1)

    def test_validation(self):
        with fake_overpass():
            resp = self.client.post(URL, form(latitude='', longitude=''))
            self.assertEqual(resp.status_code, 400)
            self.assertIn('suggestions list', resp.json()['message'])
            resp = self.client.post(URL, form(business_type='<script>x</script>', crowd_intensity='extreme', email='nope'))
            msg = resp.json()['message']
            self.assertIn('business_type', msg)
            self.assertIn('crowd intensity', msg)
            self.assertIn('email', msg)
        self.assertEqual(BusinessUser.objects.count(), 0)

    def test_get_is_rejected(self):
        self.assertEqual(self.client.get(URL).status_code, 405)
