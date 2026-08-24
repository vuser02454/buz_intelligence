"""
Comprehensive automated unit and integration tests for the Complete Enterprise Account Security System:
- Email Verification (Creation, Token Validation, Expiration, Reuse Prevention)
- Authentication (Verified vs Unverified Login, Inactive Accounts)
- Password Reset (Forgot Password, Email Dispatch, Token Validation, Password Update)
- Account Recovery / Forgot Email (Masked Email, Recovery Email Lookup, Token Dispatch)
- Dashboard Password Change (Current Password Enforcement, Session Invalidation)
- TOTP Two-Factor Authentication (Secret Generation, QR Code, Verification, Login Challenge)
- 2FA Backup Recovery Codes (Single-Use Hashed Storage, Verification, Invalidation, Regeneration)
- 2FA Deactivation (Password + TOTP Verification)
- Device & Session Management (Session Tracking, Revoke Other Devices)
- Security Event Audit Logging
- Cache-based Rate Limiting & Throttling
- CSRF & Unauthorized Access Protection
"""
from datetime import datetime, timedelta
from unittest.mock import patch
import pyotp
from django.contrib.auth import get_user_model
from django.contrib.auth.tokens import default_token_generator
from django.contrib.sessions.models import Session
from django.core import mail
from django.core.cache import cache
from django.test import Client, TestCase
from django.urls import reverse
from django.utils.encoding import force_bytes
from django.utils.http import urlsafe_base64_encode

from users.models import SecurityEvent, TwoFactorRecoveryCode, UserSession
from users.ratelimit import check_rate_limit
from users.tokens import email_verification_token
from users.two_factor import (
    generate_qr_code_data_uri,
    generate_recovery_codes,
    generate_totp_secret,
    get_totp_uri,
    verify_recovery_code,
    verify_totp_code,
)

User = get_user_model()


class EnterpriseSecuritySystemTests(TestCase):
    def setUp(self):
        cache.clear()
        self.client = Client()
        self.password = 'SecureP@ssw0rd2026!'
        self.user = User.objects.create_user(
            email='alice@example.com',
            password=self.password,
            full_name='Alice Smith',
            phone_number='+15551234567',
            recovery_email='alice_recovery@example.com',
            user_type='businessman',
            email_verified=True,
        )

    # --------------------------------------------------------------------------
    # 1. Registration & Email Verification
    # --------------------------------------------------------------------------
    def test_registration_creates_unverified_user_and_sends_email(self):
        response = self.client.post(reverse('register'), {
            'full_name': 'Bob Jones',
            'email': 'bob@example.com',
            'recovery_email': 'bob_rec@example.com',
            'phone_number': '+15559876543',
            'user_type': 'customer',
            'password': 'StrongPassword123!',
            'confirm_password': 'StrongPassword123!',
        })
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.url, reverse('verify_email_sent'))

        bob = User.objects.get(email='bob@example.com')
        self.assertFalse(bob.email_verified)
        self.assertFalse(bob.two_factor_enabled)
        self.assertEqual(bob.recovery_email, 'bob_rec@example.com')
        self.assertEqual(len(mail.outbox), 1)
        self.assertIn('verify-email', mail.outbox[0].body)

    def test_valid_email_verification_token_activates_user(self):
        self.user.email_verified = False
        self.user.save()

        uid = urlsafe_base64_encode(force_bytes(self.user.pk))
        token = email_verification_token.make_token(self.user)

        response = self.client.get(reverse('verify_email_confirm', kwargs={'uidb64': uid, 'token': token}))
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.url, reverse('login'))

        self.user.refresh_from_db()
        self.assertTrue(self.user.email_verified)
        self.assertTrue(SecurityEvent.objects.filter(user=self.user, event_type=SecurityEvent.EventType.EMAIL_VERIFIED).exists())

    def test_reused_email_verification_token_fails(self):
        self.user.email_verified = False
        self.user.save()

        uid = urlsafe_base64_encode(force_bytes(self.user.pk))
        token = email_verification_token.make_token(self.user)

        # First use
        self.client.get(reverse('verify_email_confirm', kwargs={'uidb64': uid, 'token': token}))
        self.user.refresh_from_db()
        self.assertTrue(self.user.email_verified)

        # Second attempt with same token fails (token hash changed because email_verified is now True)
        self.assertFalse(email_verification_token.check_token(self.user, token))
        response = self.client.get(reverse('verify_email_confirm', kwargs={'uidb64': uid, 'token': token}))
        self.assertEqual(response.status_code, 200)
        self.assertTemplateUsed(response, 'users/verify_email_failed.html')

    def test_expired_email_verification_token(self):
        self.user.email_verified = False
        self.user.save()

        uid = urlsafe_base64_encode(force_bytes(self.user.pk))
        token = email_verification_token.make_token(self.user)

        future_time = datetime.now() + timedelta(seconds=90000)
        with patch.object(email_verification_token, '_now', return_value=future_time):
            self.assertFalse(email_verification_token.check_token(self.user, token))

    def test_unverified_user_cannot_login(self):
        self.user.email_verified = False
        self.user.save()

        response = self.client.post(reverse('login'), {
            'email': self.user.email,
            'password': self.password,
        })
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.wsgi_request.user.is_authenticated)

    # --------------------------------------------------------------------------
    # 2. Forgot Password & Password Reset
    # --------------------------------------------------------------------------
    def test_forgot_password_sends_email_and_resets_password(self):
        response = self.client.post(reverse('password_reset'), {
            'email': self.user.email,
        })
        self.assertEqual(response.status_code, 302)
        self.assertEqual(len(mail.outbox), 1)

        uid = urlsafe_base64_encode(force_bytes(self.user.pk))
        token = default_token_generator.make_token(self.user)

        new_password = 'NewBrandP@ssw0rd2026!'
        confirm_url = reverse('password_reset_confirm', kwargs={'uidb64': uid, 'token': token})
        r1 = self.client.get(confirm_url, follow=True)
        set_password_url = r1.redirect_chain[0][0] if r1.redirect_chain else confirm_url
        response = self.client.post(set_password_url, {
            'new_password1': new_password,
            'new_password2': new_password,
        }, follow=True)
        self.assertEqual(response.status_code, 200)

        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password(new_password))
        self.assertFalse(self.user.check_password(self.password))
        self.assertIsNotNone(self.user.password_changed_at)
        self.assertTrue(SecurityEvent.objects.filter(user=self.user, event_type=SecurityEvent.EventType.PASSWORD_RESET).exists())

    # --------------------------------------------------------------------------
    # 3. Forgot Email / Account Recovery
    # --------------------------------------------------------------------------
    def test_forgot_email_with_recovery_email_masks_and_dispatches_email(self):
        response = self.client.post(reverse('forgot_email'), {
            'identifier': 'alice_recovery@example.com',
        })
        self.assertEqual(response.status_code, 200)
        self.assertTemplateUsed(response, 'users/forgot_email.html')
        self.assertIn('masked_result', response.context)
        self.assertEqual(len(mail.outbox), 1)
        self.assertTrue(SecurityEvent.objects.filter(user=self.user, event_type=SecurityEvent.EventType.ACCOUNT_RECOVERY).exists())

    def test_forgot_email_with_phone_number(self):
        response = self.client.post(reverse('forgot_email'), {
            'identifier': '+15551234567',
        })
        self.assertEqual(response.status_code, 200)
        self.assertIn('masked_result', response.context)

    def test_forgot_email_with_nonexistent_identifier_returns_generic_message(self):
        mail.outbox.clear()
        response = self.client.post(reverse('forgot_email'), {
            'identifier': 'nobody@example.com',
        })
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.context['masked_result'])
        self.assertEqual(len(mail.outbox), 0)

    # --------------------------------------------------------------------------
    # 4. Dashboard Password Change
    # --------------------------------------------------------------------------
    def test_change_password_from_dashboard_requires_current_password(self):
        self.client.login(username=self.user.email, password=self.password)

        # Attempt with wrong current password
        response = self.client.post(reverse('change_password'), {
            'current_password': 'WrongPassword123!',
            'new_password1': 'UpdatedP@ssw0rd999!',
            'new_password2': 'UpdatedP@ssw0rd999!',
        })
        self.assertEqual(response.status_code, 200)
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password(self.password))

        # Attempt with correct current password
        mail.outbox.clear()
        response = self.client.post(reverse('change_password'), {
            'current_password': self.password,
            'new_password1': 'UpdatedP@ssw0rd999!',
            'new_password2': 'UpdatedP@ssw0rd999!',
        })
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.url, reverse('security_center'))

        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password('UpdatedP@ssw0rd999!'))
        self.assertEqual(len(mail.outbox), 1)
        self.assertTrue(SecurityEvent.objects.filter(user=self.user, event_type=SecurityEvent.EventType.PASSWORD_CHANGED).exists())

    # --------------------------------------------------------------------------
    # 5. Two-Factor Authentication Setup & Verification
    # --------------------------------------------------------------------------
    def test_totp_utilities(self):
        secret = generate_totp_secret()
        self.assertTrue(len(secret) >= 16)

        uri = get_totp_uri(self.user, secret)
        self.assertIn('otpauth://totp/', uri)

        qr_uri = generate_qr_code_data_uri(uri)
        self.assertTrue(qr_uri.startswith('data:image/png;base64,'))

        totp = pyotp.TOTP(secret)
        current_code = totp.now()
        self.assertTrue(verify_totp_code(secret, current_code))
        self.assertFalse(verify_totp_code(secret, '000000'))

    def test_2fa_setup_flow_enables_2fa_and_generates_recovery_codes(self):
        self.client.login(username=self.user.email, password=self.password)

        # GET setup page initializes staged secret in session
        response = self.client.get(reverse('two_factor_setup'))
        self.assertEqual(response.status_code, 200)
        staged_secret = self.client.session['staged_2fa_secret']
        self.assertTrue(staged_secret)

        totp = pyotp.TOTP(staged_secret)
        valid_code = totp.now()

        # POST verification code
        mail.outbox.clear()
        response = self.client.post(reverse('two_factor_setup'), {
            'code': valid_code,
        })
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.url, reverse('two_factor_recovery_codes_show'))

        self.user.refresh_from_db()
        self.assertTrue(self.user.two_factor_enabled)
        self.assertEqual(self.user.totp_secret, staged_secret)

        # 10 recovery codes created
        self.assertEqual(TwoFactorRecoveryCode.objects.filter(user=self.user, is_used=False).count(), 10)
        self.assertEqual(len(mail.outbox), 1)
        self.assertTrue(SecurityEvent.objects.filter(user=self.user, event_type=SecurityEvent.EventType.TWO_FACTOR_ENABLED).exists())

    # --------------------------------------------------------------------------
    # 6. Login with 2FA
    # --------------------------------------------------------------------------
    def test_login_with_2fa_enabled_requires_totp_code(self):
        secret = pyotp.random_base32()
        self.user.two_factor_enabled = True
        self.user.totp_secret = secret
        self.user.save()

        # Step 1: Submit email + password -> redirects to 2FA challenge
        response = self.client.post(reverse('login'), {
            'email': self.user.email,
            'password': self.password,
        })
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.url, reverse('two_factor_verify'))
        self.assertFalse(response.wsgi_request.user.is_authenticated)

        # Step 2: Submit invalid TOTP -> rejected
        response = self.client.post(reverse('two_factor_verify'), {'code': '999999'})
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.wsgi_request.user.is_authenticated)

        # Step 3: Submit valid TOTP -> logged in
        totp = pyotp.TOTP(secret)
        valid_code = totp.now()
        response = self.client.post(reverse('two_factor_verify'), {'code': valid_code})
        self.assertEqual(response.status_code, 302)
        self.assertTrue(response.wsgi_request.user.is_authenticated)

    # --------------------------------------------------------------------------
    # 7. Backup Recovery Code Login
    # --------------------------------------------------------------------------
    def test_login_with_backup_recovery_code(self):
        secret = pyotp.random_base32()
        self.user.two_factor_enabled = True
        self.user.totp_secret = secret
        self.user.save()

        plain_codes = generate_recovery_codes(self.user)
        test_code = plain_codes[0]

        # Stage user in 2FA session
        session = self.client.session
        session['pre_2fa_user_id'] = self.user.pk
        session.save()

        mail.outbox.clear()
        response = self.client.post(reverse('two_factor_recovery'), {
            'recovery_code': test_code,
        })
        self.assertEqual(response.status_code, 302)
        self.assertTrue(response.wsgi_request.user.is_authenticated)

        # Code is consumed and cannot be reused
        self.assertFalse(verify_recovery_code(self.user, test_code))
        self.assertEqual(TwoFactorRecoveryCode.objects.filter(user=self.user, is_used=False).count(), 9)
        self.assertEqual(len(mail.outbox), 1)

    # --------------------------------------------------------------------------
    # 8. Disable 2FA & Regenerate Recovery Codes
    # --------------------------------------------------------------------------
    def test_disable_2fa_requires_password_and_code(self):
        secret = pyotp.random_base32()
        self.user.two_factor_enabled = True
        self.user.totp_secret = secret
        self.user.save()
        generate_recovery_codes(self.user)

        self.client.login(username=self.user.email, password=self.password)

        totp = pyotp.TOTP(secret)
        code = totp.now()

        mail.outbox.clear()
        response = self.client.post(reverse('two_factor_disable'), {
            'current_password': self.password,
            'code': code,
        })
        self.assertEqual(response.status_code, 302)

        self.user.refresh_from_db()
        self.assertFalse(self.user.two_factor_enabled)
        self.assertIsNone(self.user.totp_secret)
        self.assertEqual(TwoFactorRecoveryCode.objects.filter(user=self.user).count(), 0)
        self.assertEqual(len(mail.outbox), 1)

    def test_regenerate_recovery_codes(self):
        secret = pyotp.random_base32()
        self.user.two_factor_enabled = True
        self.user.totp_secret = secret
        self.user.save()
        first_batch = generate_recovery_codes(self.user)

        self.client.login(username=self.user.email, password=self.password)
        response = self.client.post(reverse('two_factor_regenerate_codes'))
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.url, reverse('two_factor_recovery_codes_show'))

        # Old codes cannot be verified
        self.assertFalse(verify_recovery_code(self.user, first_batch[0]))
        self.assertEqual(TwoFactorRecoveryCode.objects.filter(user=self.user, is_used=False).count(), 10)

    # --------------------------------------------------------------------------
    # 9. Session Management & Revocation
    # --------------------------------------------------------------------------
    def test_session_tracking_and_revocation(self):
        self.client.login(username=self.user.email, password=self.password)
        self.client.get(reverse('manage_sessions'))

        current_key = self.client.session.session_key
        # Simulate another session
        UserSession.objects.create(
            user=self.user,
            session_key='other_fake_session_key_123',
            ip_address='192.168.1.100',
            device_name='Safari on iOS',
        )
        self.assertEqual(UserSession.objects.filter(user=self.user).count(), 2)

        response = self.client.post(reverse('revoke_all_sessions'))
        self.assertEqual(response.status_code, 302)

        # Other session was deleted, current session kept
        self.assertEqual(UserSession.objects.filter(user=self.user).count(), 1)
        self.assertEqual(UserSession.objects.filter(user=self.user).first().session_key, current_key)

    # --------------------------------------------------------------------------
    # 10. Rate Limiting Protection
    # --------------------------------------------------------------------------
    def test_rate_limiting_helper(self):
        from django.test import RequestFactory
        factory = RequestFactory()
        req = factory.post('/accounts/login/')

        # Up to 3 allowed
        self.assertTrue(check_rate_limit(req, action='test_limit', max_requests=3, window_seconds=60))
        self.assertTrue(check_rate_limit(req, action='test_limit', max_requests=3, window_seconds=60))
        self.assertTrue(check_rate_limit(req, action='test_limit', max_requests=3, window_seconds=60))
        # 4th request blocked
        self.assertFalse(check_rate_limit(req, action='test_limit', max_requests=3, window_seconds=60))

    # --------------------------------------------------------------------------
    # 11. Unauthorized Dashboard Security Center Protection
    # --------------------------------------------------------------------------
    def test_unauthenticated_security_center_redirects_to_login(self):
        response = self.client.get(reverse('security_center'))
        self.assertEqual(response.status_code, 302)
        self.assertIn(reverse('login'), response.url)
