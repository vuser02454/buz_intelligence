"""
ws/analytics/ – pushes the LIVE revenue projection every few seconds.

Protocol (JSON):
  client -> {"action": "subscribe", "token": "<Supabase access token>", "lat": .., "lng": .., "radius": 5000, "name": ".."}
  server -> {"type": "live", "analysis_id": .., "generated_at": .., "live": {...}, "confidence": {...}}
            {"type": "pending", "retry_after": 4}            area data still being fetched
            {"type": "error", "code": "auth"|"invalid"|"rate_limited"|"unavailable", "error": ".."}
The token is sent in the first message (not the URL) so it never lands in access logs.
Values come from revenue_timeseries.build_views (deterministic; no random noise).
"""
import asyncio
import logging

from asgiref.sync import sync_to_async
from channels.generic.websocket import AsyncJsonWebsocketConsumer
from django.conf import settings

from report_generator.auth import AuthError, verify_supabase_token

from . import revenue_timeseries as ts

logger = logging.getLogger(__name__)
SUBSCRIBE_LIMIT = 20  # subscriptions per user per minute


class AnalyticsConsumer(AsyncJsonWebsocketConsumer):
    async def connect(self):
        self.task = None
        self.owner_id = None
        await self.accept()

    async def disconnect(self, code):
        if self.task:
            self.task.cancel()

    async def receive_json(self, content, **kwargs):
        if not isinstance(content, dict) or content.get('action') != 'subscribe':
            await self.send_json({'type': 'error', 'code': 'invalid', 'error': 'Expected {"action": "subscribe", ...}'})
            return
        token = str(content.get('token') or '')
        if not (20 <= len(token) <= 4096):
            await self.send_json({'type': 'error', 'code': 'auth', 'error': 'Sign in required'})
            return
        try:
            self.owner_id = await sync_to_async(verify_supabase_token, thread_sensitive=False)(token)
        except AuthError as exc:
            await self.send_json({'type': 'error', 'code': 'auth', 'error': str(exc)})
            return

        from .views import _parse_lat_lon, rate_limited
        if await sync_to_async(rate_limited)('analytics_ws', self.owner_id, SUBSCRIBE_LIMIT):
            await self.send_json({'type': 'error', 'code': 'rate_limited', 'error': 'Too many subscriptions. Wait a minute.'})
            return
        try:
            lat, lon = _parse_lat_lon(content)
        except ValueError as exc:
            await self.send_json({'type': 'error', 'code': 'invalid', 'error': str(exc)})
            return
        radius = ts.clamp_radius(content.get('radius', ts.MAX_RADIUS_M))
        name = str(content.get('name') or 'Selected area')[:120]

        if self.task:
            self.task.cancel()
        self.task = asyncio.create_task(self._push(lat, lon, radius, name))

    async def _push(self, lat, lon, radius, name):
        interval = float(getattr(settings, 'ANALYTICS_LIVE_INTERVAL', 5))
        base = None
        try:
            while True:
                if base is None:
                    base, fetched = await sync_to_async(ts.base_for_area, thread_sensitive=False)(lat, lon, radius, name)
                    if base is None:
                        if fetched['status'] == 'pending':
                            await self.send_json({'type': 'pending', 'retry_after': fetched.get('retry_after', 4)})
                        else:
                            await self.send_json({'type': 'error', 'code': 'unavailable', 'error': fetched.get('error')})
                            return
                if base is not None:
                    body = ts.payload(base, name, views=['live'])
                    await self.send_json({'type': 'live', 'analysis_id': body['analysis_id'],
                                          'generated_at': body['generated_at'], 'confidence': body['confidence'],
                                          'live': body['views']['live']})
                await asyncio.sleep(interval)
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.exception('Analytics stream failed')
            await self.send_json({'type': 'error', 'code': 'unavailable', 'error': 'Live updates stopped. Reload to retry.'})
