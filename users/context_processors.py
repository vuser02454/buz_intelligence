"""
Context processors for exposing safe Supabase settings to frontend templates.
Never exposes SUPABASE_SERVICE_ROLE_KEY.
"""
from django.conf import settings


def supabase_settings(request):
    return {
        'SUPABASE_URL': getattr(settings, 'SUPABASE_URL', ''),
        'SUPABASE_ANON_KEY': getattr(settings, 'SUPABASE_ANON_KEY', ''),
        'SITE_URL': getattr(settings, 'SITE_URL', 'http://127.0.0.1:8000'),
    }
