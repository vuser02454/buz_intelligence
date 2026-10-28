"""Part 2: ws/analytics/ consumer – auth, validation and periodic live pushes."""
from unittest.mock import patch

from channels.routing import URLRouter
from channels.testing import WebsocketCommunicator
from django.test import TransactionTestCase, override_settings

from business_intelligence.test_revenue_timeseries import sample_base
from report_generator.auth import AuthError
from tracker.routing import websocket_urlpatterns

from report_generator.tests.fixtures import LAT, LON

APP = URLRouter(websocket_urlpatterns)
TOKEN = 't' * 40


@override_settings(ANALYTICS_LIVE_INTERVAL=0.05)
class AnalyticsConsumerTests(TransactionTestCase):
    async def connect(self):
        comm = WebsocketCommunicator(APP, '/ws/analytics/')
        connected, _ = await comm.connect()
        self.assertTrue(connected)
        return comm

    async def test_pushes_live_values_repeatedly(self):
        with patch('business_intelligence.consumers_analytics.verify_supabase_token', return_value='user-12345678'), \
                patch('business_intelligence.revenue_timeseries.base_for_area', return_value=(sample_base(), None)):
            comm = await self.connect()
            await comm.send_json_to({'action': 'subscribe', 'token': TOKEN, 'lat': LAT, 'lng': LON, 'radius': 9000})
            first = await comm.receive_json_from(timeout=2)
            second = await comm.receive_json_from(timeout=2)
            await comm.disconnect()
        self.assertEqual(first['type'], 'live')
        self.assertEqual(first['analysis_id'], 'abc')
        self.assertIn('now_rate_per_hour', first['live'])
        self.assertEqual(second['type'], 'live')

    async def test_rejects_bad_token(self):
        with patch('business_intelligence.consumers_analytics.verify_supabase_token', side_effect=AuthError(401, 'Invalid or expired session.')):
            comm = await self.connect()
            await comm.send_json_to({'action': 'subscribe', 'token': TOKEN, 'lat': LAT, 'lng': LON})
            msg = await comm.receive_json_from(timeout=2)
            await comm.disconnect()
        self.assertEqual((msg['type'], msg['code']), ('error', 'auth'))

    async def test_missing_token_and_bad_coordinates(self):
        comm = await self.connect()
        await comm.send_json_to({'action': 'subscribe', 'lat': LAT, 'lng': LON})
        self.assertEqual((await comm.receive_json_from(timeout=2))['code'], 'auth')
        with patch('business_intelligence.consumers_analytics.verify_supabase_token', return_value='user-12345678'):
            await comm.send_json_to({'action': 'subscribe', 'token': TOKEN, 'lat': 'x', 'lng': LON})
            self.assertEqual((await comm.receive_json_from(timeout=2))['code'], 'invalid')
        await comm.send_json_to({'hello': 1})
        self.assertEqual((await comm.receive_json_from(timeout=2))['code'], 'invalid')
        await comm.disconnect()

    async def test_pending_area(self):
        with patch('business_intelligence.consumers_analytics.verify_supabase_token', return_value='user-12345678'), \
                patch('business_intelligence.revenue_timeseries.base_for_area',
                      return_value=(None, {'status': 'pending', 'retry_after': 4})):
            comm = await self.connect()
            await comm.send_json_to({'action': 'subscribe', 'token': TOKEN, 'lat': LAT, 'lng': LON})
            msg = await comm.receive_json_from(timeout=2)
            await comm.disconnect()
        self.assertEqual(msg['type'], 'pending')
