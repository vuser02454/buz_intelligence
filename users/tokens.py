"""
Token generators for email verification and secure account recovery.
"""
from datetime import datetime
from django.conf import settings
from django.contrib.auth.tokens import PasswordResetTokenGenerator
from django.utils.crypto import constant_time_compare
from django.utils.http import base36_to_int


class EmailVerificationTokenGenerator(PasswordResetTokenGenerator):
    """
    Cryptographically secure token generator for email verification.
    
    Features:
    - Single-use: Once email_verified is set to True, previous tokens become invalid.
    - Time-limited: Expires after EMAIL_VERIFICATION_TIMEOUT (defaults to 24 hours).
    - Account-bound: Invalidation occurs if email, active status, or password changes.
    """
    key_salt = "users.tokens.EmailVerificationTokenGenerator"

    def _make_hash_value(self, user, timestamp):
        # Incorporate pk, email, verification status, active flag, password, and timestamp
        return f"{user.pk}{timestamp}{user.email}{user.email_verified}{user.is_active}{user.password}"

    def check_token(self, user, token):
        """
        Check that a verification token is correct for a given user and not expired.
        """
        if not (user and token):
            return False

        try:
            ts_b36, _ = token.split('-')
        except ValueError:
            return False

        try:
            ts = base36_to_int(ts_b36)
        except ValueError:
            return False

        for secret in [self.secret, *self.secret_fallbacks]:
            if constant_time_compare(
                self._make_token_with_timestamp(user, ts, secret),
                token,
            ):
                break
        else:
            return False

        # Check expiration against configured timeout
        timeout = getattr(
            settings,
            'EMAIL_VERIFICATION_TIMEOUT',
            getattr(settings, 'PASSWORD_RESET_TIMEOUT', 86400),
        )
        if (self._num_seconds(self._now()) - ts) > timeout:
            return False

        return True


email_verification_token = EmailVerificationTokenGenerator()
