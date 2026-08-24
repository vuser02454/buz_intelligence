"""
Utility functions for email dispatch, verification, security notifications,
session tracking, and security event logging.
"""
import logging
from django.conf import settings
from django.contrib.sessions.models import Session
from django.contrib.sites.shortcuts import get_current_site
from django.core.mail import EmailMultiAlternatives
from django.template.loader import render_to_string
from django.urls import reverse
from django.utils.encoding import force_bytes
from django.utils.http import urlsafe_base64_encode

from .models import SecurityEvent, UserSession
from .ratelimit import get_client_ip
from .tokens import email_verification_token

logger = logging.getLogger(__name__)


def mask_email(email: str) -> str:
    """
    Mask an email address for safe display without revealing full username.
    Example: 'vvijwal01@gmail.com' -> 'v*****01@gmail.com'
    """
    if not email or '@' not in email:
        return '***@***.***'

    username, domain = email.split('@', 1)
    if len(username) <= 2:
        masked_user = username[0] + '*'
    elif len(username) <= 4:
        masked_user = username[0] + '*' * (len(username) - 1)
    else:
        masked_user = username[0] + '*' * (len(username) - 3) + username[-2:]

    return f"{masked_user}@{domain}"


def log_security_event(user, event_type: str, request=None):
    """
    Record an audit entry in SecurityEvent without logging credentials or secrets.
    """
    if not user or not user.is_authenticated and not getattr(user, 'pk', None):
        return None

    ip = get_client_ip(request) if request else None
    user_agent = request.META.get('HTTP_USER_AGENT', '') if request else None

    try:
        return SecurityEvent.objects.create(
            user=user,
            event_type=event_type,
            ip_address=ip,
            user_agent=user_agent[:500] if user_agent else None,
        )
    except Exception as exc:
        logger.error("Failed to log security event %s for %s: %s", event_type, user, exc)
        return None


def get_device_name(user_agent: str) -> str:
    """Parse user agent into a user-friendly device/browser description."""
    if not user_agent:
        return "Unknown Device"

    ua = user_agent.lower()
    browser = "Browser"
    if "edg" in ua:
        browser = "Edge"
    elif "chrome" in ua and "chromium" not in ua and "edg" not in ua:
        browser = "Chrome"
    elif "firefox" in ua:
        browser = "Firefox"
    elif "safari" in ua and "chrome" not in ua:
        browser = "Safari"

    os_name = "Desktop"
    if "iphone" in ua or "ipad" in ua:
        os_name = "iOS"
    elif "android" in ua:
        os_name = "Android"
    elif "macintosh" in ua or "mac os" in ua:
        os_name = "macOS"
    elif "windows" in ua:
        os_name = "Windows"
    elif "linux" in ua:
        os_name = "Linux"

    return f"{browser} on {os_name}"


def track_user_session(user, request):
    """Record or update active session entry for session management."""
    if not user or not request or not request.session.session_key:
        return None

    session_key = request.session.session_key
    ip = get_client_ip(request)
    user_agent = request.META.get('HTTP_USER_AGENT', '')
    device_name = get_device_name(user_agent)

    try:
        session_obj, _ = UserSession.objects.update_or_create(
            session_key=session_key,
            defaults={
                'user': user,
                'ip_address': ip,
                'user_agent': user_agent[:500] if user_agent else None,
                'device_name': device_name,
            },
        )
        return session_obj
    except Exception as exc:
        logger.error("Failed to track session %s: %s", session_key, exc)
        return None


def revoke_all_other_sessions(user, current_session_key: str = None):
    """
    Invalidate all other active sessions for this user across devices.
    """
    sessions_to_revoke = UserSession.objects.filter(user=user)
    if current_session_key:
        sessions_to_revoke = sessions_to_revoke.exclude(session_key=current_session_key)

    keys = list(sessions_to_revoke.values_list('session_key', flat=True))
    if keys:
        Session.objects.filter(session_key__in=keys).delete()
        sessions_to_revoke.delete()
        logger.info("Revoked %d sessions for %s", len(keys), user.email)


def _send_email_template(subject_template, text_template, html_template, context, recipient_list):
    """Helper to render and send multipart HTML + text emails."""
    subject = render_to_string(subject_template, context).strip()
    text_content = render_to_string(text_template, context)
    html_content = render_to_string(html_template, context)
    from_email = getattr(settings, 'DEFAULT_FROM_EMAIL', 'Crowd Heatmap <onboarding@resend.dev>')

    try:
        msg = EmailMultiAlternatives(
            subject=subject,
            body=text_content,
            from_email=from_email,
            to=recipient_list,
        )
        msg.attach_alternative(html_content, "text/html")
        msg.send(fail_silently=False)
        return True
    except Exception as exc:
        logger.error("Failed to send email '%s' to %s: %s", subject, recipient_list, exc)
        return False


def send_verification_email(user, request=None):
    """Send secure email verification link."""
    uid = urlsafe_base64_encode(force_bytes(user.pk))
    token = email_verification_token.make_token(user)

    if request is not None:
        protocol = 'https' if request.is_secure() else 'http'
        domain = get_current_site(request).domain
    else:
        protocol = 'https' if not getattr(settings, 'DEBUG', True) else 'http'
        domain = 'localhost:8000'

    relative_url = reverse('verify_email_confirm', kwargs={'uidb64': uid, 'token': token})
    verification_url = f"{protocol}://{domain}{relative_url}"

    timeout_seconds = getattr(settings, 'EMAIL_VERIFICATION_TIMEOUT', 86400)
    expiration_hours = max(1, int(timeout_seconds // 3600))

    context = {
        'user': user,
        'verification_url': verification_url,
        'protocol': protocol,
        'domain': domain,
        'expiration_hours': expiration_hours,
        'site_name': 'Crowd Heatmap',
    }

    return _send_email_template(
        'users/emails/verification_subject.txt',
        'users/emails/verification_email.txt',
        'users/emails/verification_email.html',
        context,
        [user.email],
    )


def send_password_changed_notification(user, request=None):
    """Send security notification when password is updated."""
    ip = get_client_ip(request) if request else 'Unknown'
    context = {
        'user': user,
        'ip_address': ip,
        'site_name': 'Crowd Heatmap',
    }
    return _send_email_template(
        'users/emails/password_changed_subject.txt',
        'users/emails/password_changed_email.txt',
        'users/emails/password_changed_email.html',
        context,
        [user.email],
    )


def send_2fa_enabled_notification(user, request=None):
    """Send security notification when 2FA is activated."""
    ip = get_client_ip(request) if request else 'Unknown'
    context = {
        'user': user,
        'ip_address': ip,
        'site_name': 'Crowd Heatmap',
    }
    return _send_email_template(
        'users/emails/2fa_enabled_subject.txt',
        'users/emails/2fa_enabled_email.txt',
        'users/emails/2fa_enabled_email.html',
        context,
        [user.email],
    )


def send_2fa_disabled_notification(user, request=None):
    """Send security notification when 2FA is deactivated."""
    ip = get_client_ip(request) if request else 'Unknown'
    context = {
        'user': user,
        'ip_address': ip,
        'site_name': 'Crowd Heatmap',
    }
    return _send_email_template(
        'users/emails/2fa_disabled_subject.txt',
        'users/emails/2fa_disabled_email.txt',
        'users/emails/2fa_disabled_email.html',
        context,
        [user.email],
    )


def send_recovery_code_used_notification(user, request=None):
    """Send security alert when a backup recovery code is consumed for login."""
    ip = get_client_ip(request) if request else 'Unknown'
    context = {
        'user': user,
        'ip_address': ip,
        'site_name': 'Crowd Heatmap',
    }
    return _send_email_template(
        'users/emails/recovery_code_used_subject.txt',
        'users/emails/recovery_code_used_email.txt',
        'users/emails/recovery_code_used_email.html',
        context,
        [user.email],
    )


def send_account_recovery_email(user, target_email: str, request=None):
    """Send account recovery email with masked email and password reset instructions."""
    from django.contrib.auth.tokens import default_token_generator
    uid = urlsafe_base64_encode(force_bytes(user.pk))
    token = default_token_generator.make_token(user)

    if request is not None:
        protocol = 'https' if request.is_secure() else 'http'
        domain = get_current_site(request).domain
    else:
        protocol = 'https' if not getattr(settings, 'DEBUG', True) else 'http'
        domain = 'localhost:8000'

    reset_url = f"{protocol}://{domain}{reverse('password_reset_confirm', kwargs={'uidb64': uid, 'token': token})}"

    context = {
        'user': user,
        'masked_email': mask_email(user.email),
        'reset_url': reset_url,
        'site_name': 'Crowd Heatmap',
    }

    recipients = list(set([target_email, user.email]))
    return _send_email_template(
        'users/emails/account_recovery_subject.txt',
        'users/emails/account_recovery_email.txt',
        'users/emails/account_recovery_email.html',
        context,
        recipients,
    )
