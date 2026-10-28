"""Auth-related pages: gate wording, safe `next`, e-mail callback, non-blocking activity log."""
import json
from unittest.mock import patch

from django.test import TestCase, override_settings
from django.test.client import RequestFactory

from business_intelligence.views import safe_next_url


class SafeNextUrlTests(TestCase):
    def next_for(self, value):
        return safe_next_url(RequestFactory().get('/login/', {'next': value}))

    def test_same_site_paths_are_kept(self):
        self.assertEqual(self.next_for('/dashboard/?auto_map=true'), '/dashboard/?auto_map=true')
        self.assertEqual(self.next_for('/favorites/'), '/favorites/')

    def test_external_and_tricky_targets_fall_back_to_dashboard(self):
        for bad in ('https://evil.example/', '//evil.example/x', 'javascript:alert(1)', '/\\evil.example', '', 'dashboard'):
            self.assertEqual(self.next_for(bad), '/dashboard/', bad)


class AuthPagesTests(TestCase):
    def test_gate_modal_has_no_infrastructure_text(self):
        html = self.client.get('/dashboard/').content.decode()
        self.assertIn('supabase-auth-gate-modal', html)
        self.assertNotIn('Supabase Project DB Connected', html)
        self.assertNotIn('requires Supabase Authentication', html)

    def test_sdk_is_loaded_once_and_pinned(self):
        for url in ('/login/', '/profile/', '/dashboard/'):
            html = self.client.get(url).content.decode()
            self.assertEqual(html.count('@supabase/supabase-js@'), 1, url)
            self.assertEqual(html.count('js/supabase-auth.js'), 1, url)
            self.assertNotIn('supabase-js@2"', html, 'unpinned SDK on ' + url)

    def test_login_page_passes_sanitised_next(self):
        html = self.client.get('/login/', {'next': 'https://evil.example'}).content.decode()
        self.assertIn('<script id="login-next-url" type="application/json">"/dashboard/"</script>', html)
        html = self.client.get('/login/', {'next': '/dashboard/?auto_map=true'}).content.decode()
        self.assertIn('"/dashboard/?auto_map=true"', html)
        self.assertNotIn('Supabase', html.split('<title>')[1].split('</title>')[0])

    @override_settings(SITE_URL='https://bi.example.com')
    def test_site_url_reaches_the_auth_script(self):
        html = self.client.get('/login/').content.decode()
        self.assertIn("siteUrl: 'https://bi.example.com'", html)

    def test_auth_callback_page(self):
        resp = self.client.get('/auth/callback/', {'next': '/dashboard/?auto_map=true'})
        self.assertEqual(resp.status_code, 200)
        html = resp.content.decode()
        self.assertIn('<script id="callback-next-url" type="application/json">"/dashboard/?auto_map=true"</script>', html)
        self.assertIn('SupabaseAuth.refresh()', html)
        resp = self.client.get('/auth/callback/', {'next': 'https://evil.example'})
        self.assertIn('"/dashboard/"', resp.content.decode())


class ActivityLogTests(TestCase):
    def test_log_is_queued_not_written_in_the_request(self):
        with patch('business_intelligence.supabase_service.log_activity_to_supabase') as sync_write, \
                patch('business_intelligence.supabase_service.log_activity_async') as queued:
            resp = self.client.post('/api/log-activity/', json.dumps({'event_type': 'auth_login', 'details': {'a': 1}}),
                                    content_type='application/json')
        self.assertEqual(resp.status_code, 202)
        queued.assert_called_once()
        sync_write.assert_not_called()

    def test_oversized_details_are_dropped(self):
        with patch('business_intelligence.supabase_service.log_activity_async') as queued:
            self.client.post('/api/log-activity/', json.dumps({'event_type': 'x', 'details': {'blob': 'a' * 10000}}),
                             content_type='application/json')
        self.assertEqual(queued.call_args.kwargs['details'], {})
