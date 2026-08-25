"""
Supabase GoTrue Auth Service.
Handles interaction with Supabase Authentication API for user registration,
email verification dispatch, credential verification, and password resets.
Never exposes secret keys or raw sensitive tokens to the frontend.
"""
import logging
import uuid
import requests
from django.conf import settings
from django.utils import timezone
from .models import CustomUser, UserType

logger = logging.getLogger(__name__)


def is_supabase_configured() -> bool:
    """Check whether Supabase environment variables are properly set."""
    return bool(getattr(settings, 'SUPABASE_URL', '') and getattr(settings, 'SUPABASE_ANON_KEY', ''))


def _get_api_headers(use_service_key: bool = False, bearer_token: str = None) -> dict:
    """Build standard headers for Supabase GoTrue Auth REST endpoints."""
    anon_key = getattr(settings, 'SUPABASE_ANON_KEY', '')
    service_key = getattr(settings, 'SUPABASE_SERVICE_ROLE_KEY', '')

    chosen_key = service_key if (use_service_key and service_key) else anon_key

    headers = {
        'apikey': chosen_key,
        'Content-Type': 'application/json',
    }

    if bearer_token:
        headers['Authorization'] = f'Bearer {bearer_token}'
    else:
        headers['Authorization'] = f'Bearer {chosen_key}'

    return headers


def sign_up(email: str, password: str, metadata: dict = None, redirect_to: str = None) -> dict:
    """
    Register new identity with Supabase Auth.
    Supabase handles hashing and dispatches the confirmation email.
    """
    if not is_supabase_configured():
        return {'success': False, 'error': 'Supabase is not configured in settings.'}

    url = f"{settings.SUPABASE_URL}/auth/v1/signup"
    site_url = getattr(settings, 'SITE_URL', 'http://127.0.0.1:8000')
    default_redirect = f"{site_url}/accounts/auth/callback/"

    payload = {
        'email': email.strip().lower(),
        'password': password,
        'data': metadata or {},
    }

    redirect = redirect_to or default_redirect
    if redirect:
        payload['options'] = {'emailRedirectTo': redirect}

    try:
        response = requests.post(
            url,
            json=payload,
            headers=_get_api_headers(),
            timeout=10,
        )
        data = response.json()

        if response.status_code in (200, 201):
            user_data = data.get('user') or data
            is_confirmed = bool(user_data.get('email_confirmed_at') or user_data.get('confirmed_at'))
            return {
                'success': True,
                'user': user_data,
                'is_confirmed': is_confirmed,
                'session': data.get('session'),
            }
        else:
            error_msg = data.get('msg') or data.get('message') or data.get('error_description') or 'Registration failed'
            logger.warning("Supabase signup failed for %s: %s", email, error_msg)
            return {'success': False, 'error': error_msg}

    except Exception as exc:
        logger.error("Exception in Supabase sign_up for %s: %s", email, exc)
        return {'success': False, 'error': 'Unable to connect to authentication server. Please try again.'}


def sign_in_with_password(email: str, password: str) -> dict:
    """
    Authenticate user credentials via Supabase GoTrue Auth token endpoint.
    """
    if not is_supabase_configured():
        return {'success': False, 'error': 'Supabase is not configured.'}

    url = f"{settings.SUPABASE_URL}/auth/v1/token?grant_type=password"
    payload = {
        'email': email.strip().lower(),
        'password': password,
    }

    try:
        response = requests.post(
            url,
            json=payload,
            headers=_get_api_headers(),
            timeout=10,
        )
        data = response.json()

        if response.status_code == 200:
            user_data = data.get('user') or {}
            is_confirmed = bool(user_data.get('email_confirmed_at') or user_data.get('confirmed_at'))
            return {
                'success': True,
                'user': user_data,
                'access_token': data.get('access_token'),
                'refresh_token': data.get('refresh_token'),
                'is_confirmed': is_confirmed,
            }
        else:
            error_msg = data.get('error_description') or data.get('msg') or data.get('message') or 'Invalid login credentials.'
            logger.warning("Supabase signin failed for %s: %s", email, error_msg)
            return {
                'success': False,
                'error': error_msg,
                'is_unconfirmed': 'Email not confirmed' in error_msg or 'email_not_confirmed' in str(data),
            }

    except Exception as exc:
        logger.error("Exception in Supabase sign_in_with_password for %s: %s", email, exc)
        return {'success': False, 'error': 'Authentication service currently unavailable.'}


def send_password_reset_email(email: str, redirect_to: str = None) -> dict:
    """
    Send password recovery email via Supabase Auth.
    """
    if not is_supabase_configured():
        return {'success': False, 'error': 'Supabase is not configured.'}

    url = f"{settings.SUPABASE_URL}/auth/v1/recover"
    site_url = getattr(settings, 'SITE_URL', 'http://127.0.0.1:8000')
    default_redirect = f"{site_url}/accounts/password-reset-confirm/"

    payload = {
        'email': email.strip().lower(),
        'options': {'emailRedirectTo': redirect_to or default_redirect},
    }

    try:
        response = requests.post(
            url,
            json=payload,
            headers=_get_api_headers(),
            timeout=10,
        )
        if response.status_code in (200, 204):
            return {'success': True}
        data = response.json()
        error_msg = data.get('msg') or data.get('message') or 'Password reset request failed.'
        return {'success': False, 'error': error_msg}
    except Exception as exc:
        logger.error("Exception in Supabase send_password_reset_email for %s: %s", email, exc)
        return {'success': False, 'error': 'Unable to process reset request.'}


def update_user_password(access_token: str, new_password: str) -> dict:
    """
    Update password in Supabase Auth using the user's recovery or active access token.
    """
    if not is_supabase_configured():
        return {'success': False, 'error': 'Supabase is not configured.'}

    url = f"{settings.SUPABASE_URL}/auth/v1/user"
    payload = {'password': new_password}

    try:
        response = requests.put(
            url,
            json=payload,
            headers=_get_api_headers(bearer_token=access_token),
            timeout=10,
        )
        data = response.json()
        if response.status_code == 200:
            return {'success': True, 'user': data}
        error_msg = data.get('msg') or data.get('message') or 'Failed to update password.'
        return {'success': False, 'error': error_msg}
    except Exception as exc:
        logger.error("Exception in Supabase update_user_password: %s", exc)
        return {'success': False, 'error': 'Password update failed.'}


def resend_verification_email(email: str, redirect_to: str = None) -> dict:
    """
    Resend confirmation email for unverified user.
    """
    if not is_supabase_configured():
        return {'success': False, 'error': 'Supabase is not configured.'}

    url = f"{settings.SUPABASE_URL}/auth/v1/resend"
    site_url = getattr(settings, 'SITE_URL', 'http://127.0.0.1:8000')
    default_redirect = f"{site_url}/accounts/auth/callback/"

    payload = {
        'type': 'signup',
        'email': email.strip().lower(),
        'options': {'emailRedirectTo': redirect_to or default_redirect},
    }

    try:
        response = requests.post(
            url,
            json=payload,
            headers=_get_api_headers(),
            timeout=10,
        )
        if response.status_code in (200, 204):
            return {'success': True}
        data = response.json()
        error_msg = data.get('msg') or data.get('message') or 'Unable to resend verification email.'
        return {'success': False, 'error': error_msg}
    except Exception as exc:
        logger.error("Exception in Supabase resend_verification_email for %s: %s", email, exc)
        return {'success': False, 'error': 'Unable to connect to verification server.'}


def get_user_by_token(access_token: str) -> dict:
    """
    Validate Supabase JWT and retrieve user profile from Supabase Auth.
    """
    if not is_supabase_configured() or not access_token:
        return {'success': False, 'error': 'Invalid request.'}

    url = f"{settings.SUPABASE_URL}/auth/v1/user"

    try:
        response = requests.get(
            url,
            headers=_get_api_headers(bearer_token=access_token),
            timeout=10,
        )
        data = response.json()
        if response.status_code == 200 and 'id' in data:
            is_confirmed = bool(data.get('email_confirmed_at') or data.get('confirmed_at'))
            return {
                'success': True,
                'user': data,
                'is_confirmed': is_confirmed,
            }
        return {'success': False, 'error': data.get('msg') or 'Invalid or expired token.'}
    except Exception as exc:
        logger.error("Exception in Supabase get_user_by_token: %s", exc)
        return {'success': False, 'error': 'Could not verify token.'}


def get_or_sync_custom_user(supabase_user_data: dict, additional_fields: dict = None) -> CustomUser:
    """
    Safely locate or create the corresponding CustomUser profile for a Supabase identity.
    Preserves all existing Django user data and 2FA secrets without creating duplicates.
    """
    if not supabase_user_data:
        return None

    raw_supabase_id = supabase_user_data.get('id')
    try:
        supabase_uuid = uuid.UUID(str(raw_supabase_id)) if raw_supabase_id else None
    except (ValueError, TypeError):
        supabase_uuid = None

    email = (supabase_user_data.get('email') or '').strip().lower()
    if not email:
        return None

    metadata = supabase_user_data.get('user_metadata') or {}
    is_confirmed = bool(supabase_user_data.get('email_confirmed_at') or supabase_user_data.get('confirmed_at'))

    extra = additional_fields or {}

    # 1. Look up by supabase_user_id first
    user = None
    if supabase_uuid:
        user = CustomUser.objects.filter(supabase_user_id=supabase_uuid).first()

    # 2. If not found, look up by email to link existing Django accounts
    if not user:
        user = CustomUser.objects.filter(email__iexact=email).first()
        if user and supabase_uuid:
            user.supabase_user_id = supabase_uuid

    # 3. If still not found, create new CustomUser
    if not user:
        full_name = extra.get('full_name') or metadata.get('full_name') or email.split('@')[0]
        phone_number = extra.get('phone_number') or metadata.get('phone_number') or ''
        user_type = extra.get('user_type') or metadata.get('user_type') or UserType.CUSTOMER
        recovery_email = extra.get('recovery_email') or metadata.get('recovery_email') or None

        user = CustomUser.objects.create(
            email=email,
            supabase_user_id=supabase_uuid,
            full_name=full_name,
            phone_number=phone_number,
            user_type=user_type,
            recovery_email=recovery_email,
            email_verified=is_confirmed,
            is_active=True,
        )
        user.set_unusable_password()  # Password is authenticated via Supabase Auth
        user.save()
        logger.info("Created new CustomUser profile for Supabase identity %s (%s)", supabase_uuid, email)
        return user

    # 4. Update existing user's state
    updated_fields = []
    if supabase_uuid and user.supabase_user_id != supabase_uuid:
        user.supabase_user_id = supabase_uuid
        updated_fields.append('supabase_user_id')

    if is_confirmed and not user.email_verified:
        user.email_verified = True
        updated_fields.append('email_verified')

    # Update metadata if fields are empty on existing record
    if extra.get('full_name') and not user.full_name:
        user.full_name = extra['full_name']
        updated_fields.append('full_name')

    if extra.get('phone_number') and not user.phone_number:
        user.phone_number = extra['phone_number']
        updated_fields.append('phone_number')

    if extra.get('recovery_email') and not user.recovery_email:
        user.recovery_email = extra['recovery_email']
        updated_fields.append('recovery_email')

    if updated_fields:
        user.save(update_fields=updated_fields)

    return user
