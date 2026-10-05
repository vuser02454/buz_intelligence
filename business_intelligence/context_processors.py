from django.conf import settings


def supabase_settings(request):
    """
    Exposes Supabase project configuration to all templates.
    """
    return {
        'SUPABASE_URL': getattr(settings, 'SUPABASE_URL', 'https://ijsfmdgysmwovaighumv.supabase.co'),
        'SUPABASE_ANON_KEY': getattr(settings, 'SUPABASE_ANON_KEY', 'sb_publishable_EdW1JxXZSkEA1uV4Yl4eIg_F9dvq-2h'),
    }
