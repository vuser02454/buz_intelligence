from django.urls import re_path
from business_intelligence.consumers_analytics import AnalyticsConsumer
from . import consumers

websocket_urlpatterns = [
    re_path(r'ws/chat/$', consumers.ChatConsumer.as_asgi()),
    re_path(r'ws/analytics/$', AnalyticsConsumer.as_asgi()),
]
