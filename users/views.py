"""
Authentication, Registration, 2FA, Security Center, and Account Recovery Views.
"""
import logging
from django.conf import settings
from django.contrib import messages
from django.contrib.auth import login, logout, update_session_auth_hash
from django.contrib.auth.decorators import login_required
from django.contrib.auth.views import (
    PasswordResetCompleteView,
    PasswordResetConfirmView,
    PasswordResetDoneView,
    PasswordResetView,
)
from django.db.models import Q
from django.shortcuts import get_object_or_404, redirect, render
from django.urls import reverse, reverse_lazy
from django.utils import timezone
from django.utils.http import urlsafe_base64_decode

from .forms import (
    ChangePasswordDashboardForm,
    CustomPasswordResetForm,
    CustomSetPasswordForm,
    ForgotEmailForm,
    LoginForm,
    ResendVerificationForm,
    TwoFactorDisableForm,
    TwoFactorRecoveryCodeForm,
    TwoFactorSetupConfirmForm,
    TwoFactorVerifyForm,
    UserCreationForm,
)
from .models import CustomUser, SecurityEvent, TwoFactorRecoveryCode, UserSession
from .ratelimit import check_rate_limit, rate_limit_required
from .tokens import email_verification_token
from .two_factor import (
    generate_qr_code_data_uri,
    generate_recovery_codes,
    generate_totp_secret,
    get_totp_uri,
    verify_recovery_code,
    verify_totp_code,
)
from .utils import (
    log_security_event,
    mask_email,
    revoke_all_other_sessions,
    send_2fa_disabled_notification,
    send_2fa_enabled_notification,
    send_account_recovery_email,
    send_password_changed_notification,
    send_recovery_code_used_notification,
    send_verification_email,
    track_user_session,
)

logger = logging.getLogger(__name__)


def register_view(request):
    """Register new user, create unverified account, send verification email."""
    if request.user.is_authenticated:
        return redirect('dashboard')

    if request.method == 'POST':
        if not check_rate_limit(request, action='register', max_requests=10, window_seconds=300):
            messages.error(request, 'Too many registration attempts. Please wait a few minutes.')
            return redirect('register')

        form = UserCreationForm(request.POST)
        if form.is_valid():
            user = form.save()
            send_verification_email(user, request)
            request.session['verify_email_sent_to'] = user.email
            return redirect('verify_email_sent')
    else:
        form = UserCreationForm()

    return render(request, 'users/register.html', {'form': form})


def login_view(request):
    """Authenticate credentials. Handles 2FA staging and unverified restrictions."""
    if request.user.is_authenticated:
        return redirect('dashboard')

    unverified_email = None

    if request.method == 'POST':
        if not check_rate_limit(request, action='login', max_requests=10, window_seconds=300):
            messages.error(request, 'Too many login attempts. Please wait a few minutes before trying again.')
            return redirect('login')

        form = LoginForm(request.POST)
        if form.is_valid():
            user = form.get_user()
            remember_me = form.cleaned_data.get('remember_me', False)

            # Check if 2FA is active
            if getattr(user, 'two_factor_enabled', False) and user.totp_secret:
                request.session['pre_2fa_user_id'] = user.pk
                request.session['pre_2fa_remember_me'] = remember_me
                request.session['pre_2fa_next'] = request.POST.get('next', request.GET.get('next', 'dashboard'))
                return redirect('two_factor_verify')

            # Standard Login
            login(request, user)
            if not remember_me:
                request.session.set_expiry(0)

            track_user_session(user, request)
            log_security_event(user, SecurityEvent.EventType.LOGIN, request)

            messages.success(request, f"Welcome back, {user.full_name or user.email}!")
            next_url = request.POST.get('next') or request.GET.get('next') or 'dashboard'
            return redirect(next_url)
        else:
            unverified_email = getattr(form, 'unverified_email', None)
    else:
        form = LoginForm()

    return render(request, 'users/login.html', {
        'form': form,
        'unverified_email': unverified_email,
    })


def two_factor_verify_view(request):
    """Second-factor verification step during login (TOTP code)."""
    user_id = request.session.get('pre_2fa_user_id')
    if not user_id:
        return redirect('login')

    user = get_object_or_404(CustomUser, pk=user_id)

    if request.method == 'POST':
        if not check_rate_limit(request, action='2fa_verify', max_requests=8, window_seconds=300, identifier=f"2fa_{user.pk}"):
            messages.error(request, 'Too many failed verification attempts. Please wait a few minutes.')
            return redirect('two_factor_verify')

        form = TwoFactorVerifyForm(request.POST)
        if form.is_valid():
            code = form.cleaned_data['code']
            if verify_totp_code(user.totp_secret, code):
                remember_me = request.session.pop('pre_2fa_remember_me', False)
                next_url = request.session.pop('pre_2fa_next', 'dashboard')
                request.session.pop('pre_2fa_user_id', None)

                login(request, user)
                if not remember_me:
                    request.session.set_expiry(0)

                track_user_session(user, request)
                log_security_event(user, SecurityEvent.EventType.LOGIN, request)

                messages.success(request, f"Welcome back, {user.full_name or user.email}!")
                return redirect(next_url)
            else:
                log_security_event(user, SecurityEvent.EventType.FAILED_2FA_ATTEMPT, request)
                messages.error(request, 'Invalid authenticator code. Please check your app and try again.')
    else:
        form = TwoFactorVerifyForm()

    return render(request, 'users/2fa_verify.html', {
        'form': form,
        'user_email': mask_email(user.email),
    })


def two_factor_recovery_view(request):
    """Backup login with a single-use recovery code."""
    user_id = request.session.get('pre_2fa_user_id')
    if not user_id:
        return redirect('login')

    user = get_object_or_404(CustomUser, pk=user_id)

    if request.method == 'POST':
        if not check_rate_limit(request, action='2fa_recovery', max_requests=5, window_seconds=300, identifier=f"rec_{user.pk}"):
            messages.error(request, 'Too many failed recovery code attempts. Please wait 5 minutes.')
            return redirect('two_factor_recovery')

        form = TwoFactorRecoveryCodeForm(request.POST)
        if form.is_valid():
            code = form.cleaned_data['recovery_code']
            if verify_recovery_code(user, code):
                remember_me = request.session.pop('pre_2fa_remember_me', False)
                next_url = request.session.pop('pre_2fa_next', 'dashboard')
                request.session.pop('pre_2fa_user_id', None)

                login(request, user)
                if not remember_me:
                    request.session.set_expiry(0)

                track_user_session(user, request)
                log_security_event(user, SecurityEvent.EventType.RECOVERY_CODE_USED, request)
                send_recovery_code_used_notification(user, request)

                messages.warning(
                    request,
                    'You signed in using a backup recovery code. That code is now consumed and cannot be reused.'
                )
                return redirect(next_url)
            else:
                log_security_event(user, SecurityEvent.EventType.FAILED_2FA_ATTEMPT, request)
                messages.error(request, 'Invalid or already consumed recovery code.')
    else:
        form = TwoFactorRecoveryCodeForm()

    return render(request, 'users/2fa_recovery.html', {
        'form': form,
        'user_email': mask_email(user.email),
    })


def logout_view(request):
    """Log out user, remove session tracking, redirect to login."""
    if request.user.is_authenticated:
        user = request.user
        session_key = request.session.session_key
        log_security_event(user, SecurityEvent.EventType.LOGOUT, request)
        if session_key:
            UserSession.objects.filter(session_key=session_key).delete()

    logout(request)
    messages.info(request, 'You have been successfully logged out.')
    return redirect('login')


def verify_email_sent_view(request):
    """Notice page after registration or verification resend."""
    email = request.session.get('verify_email_sent_to', '')
    masked = mask_email(email) if email else ''
    return render(request, 'users/verify_email_sent.html', {'email': email, 'masked_email': masked})


def verify_email_confirm_view(request, uidb64, token):
    """Verify time-limited single-use email verification link."""
    try:
        uid = urlsafe_base64_decode(uidb64).decode()
        user = CustomUser.objects.get(pk=uid)
    except (TypeError, ValueError, OverflowError, CustomUser.DoesNotExist):
        user = None

    if user is not None and email_verification_token.check_token(user, token):
        user.email_verified = True
        user.save(update_fields=['email_verified'])
        log_security_event(user, SecurityEvent.EventType.EMAIL_VERIFIED, request)
        messages.success(request, 'Your email address has been successfully verified! You can now log in.')
        return redirect('login')
    else:
        return render(request, 'users/verify_email_failed.html', {
            'resend_url': reverse('resend_verification'),
        })


def resend_verification_view(request):
    """Generic resend verification endpoint without account enumeration."""
    if request.method == 'POST':
        if not check_rate_limit(request, action='resend_verification', max_requests=5, window_seconds=300):
            messages.error(request, 'Too many requests. Please wait a few minutes before trying again.')
            return redirect('resend_verification')

        form = ResendVerificationForm(request.POST)
        if form.is_valid():
            email = form.cleaned_data['email']
            user = CustomUser.objects.filter(email__iexact=email, is_active=True).first()
            if user and not user.email_verified:
                send_verification_email(user, request)

            request.session['verify_email_sent_to'] = email
            messages.info(request, 'If an unverified account exists with that email, a new verification link has been sent.')
            return redirect('verify_email_sent')
    else:
        initial_email = request.GET.get('email', '')
        form = ResendVerificationForm(initial={'email': initial_email})

    return render(request, 'users/resend_verification.html', {'form': form})


def forgot_email_view(request):
    """
    Account recovery / Forgot email.
    Finds account by recovery email or phone number, sends recovery details and reset link securely,
    and shows masked email hint without leaking exact full username.
    """
    masked_result = None

    if request.method == 'POST':
        if not check_rate_limit(request, action='forgot_email', max_requests=5, window_seconds=300):
            messages.error(request, 'Too many recovery attempts. Please wait 5 minutes.')
            return redirect('forgot_email')

        form = ForgotEmailForm(request.POST)
        if form.is_valid():
            identifier = form.cleaned_data['identifier'].strip()
            # Search by recovery email or phone number or exact email
            user = CustomUser.objects.filter(
                Q(recovery_email__iexact=identifier) |
                Q(phone_number__iexact=identifier) |
                Q(email__iexact=identifier),
                is_active=True
            ).first()

            if user:
                masked_result = mask_email(user.email)
                log_security_event(user, SecurityEvent.EventType.ACCOUNT_RECOVERY, request)
                target = user.recovery_email or user.email
                send_account_recovery_email(user, target, request)

            messages.success(
                request,
                'If an account matches your details, recovery instructions have been sent to your registered contact method.'
            )
    else:
        form = ForgotEmailForm()

    return render(request, 'users/forgot_email.html', {
        'form': form,
        'masked_result': masked_result,
    })


# Password Reset Views with Custom Forms
class CustomPasswordResetView(PasswordResetView):
    template_name = 'users/password_reset.html'
    email_template_name = 'users/emails/password_reset_email.html'
    subject_template_name = 'users/emails/password_reset_subject.txt'
    form_class = CustomPasswordResetForm
    success_url = reverse_lazy('password_reset_done')

    def form_valid(self, form):
        if not check_rate_limit(self.request, action='password_reset', max_requests=5, window_seconds=300):
            messages.error(self.request, 'Too many password reset requests. Please wait a few minutes.')
            return redirect('password_reset')
        return super().form_valid(form)


class CustomPasswordResetDoneView(PasswordResetDoneView):
    template_name = 'users/password_reset_done.html'


class CustomPasswordResetConfirmView(PasswordResetConfirmView):
    template_name = 'users/password_reset_confirm.html'
    form_class = CustomSetPasswordForm
    success_url = reverse_lazy('password_reset_complete')

    def form_valid(self, form):
        user = form.user
        user.password_changed_at = timezone.now()
        user.save(update_fields=['password_changed_at'])
        log_security_event(user, SecurityEvent.EventType.PASSWORD_RESET, self.request)
        send_password_changed_notification(user, self.request)
        return super().form_valid(form)


class CustomPasswordResetCompleteView(PasswordResetCompleteView):
    template_name = 'users/password_reset_complete.html'


# ==============================================================================
# DASHBOARD SECURITY CENTER & ACCOUNT VIEWS (LOGIN REQUIRED)
# ==============================================================================

@login_required
def security_center_view(request):
    """Dashboard Security & Account Overview."""
    user = request.user
    recent_events = SecurityEvent.objects.filter(user=user)[:6]
    active_sessions_count = UserSession.objects.filter(user=user).count()
    remaining_recovery_codes = TwoFactorRecoveryCode.objects.filter(user=user, is_used=False).count()

    return render(request, 'users/security_center.html', {
        'masked_email': mask_email(user.email),
        'masked_recovery_email': mask_email(user.recovery_email) if user.recovery_email else None,
        'recent_events': recent_events,
        'active_sessions_count': max(1, active_sessions_count),
        'remaining_recovery_codes': remaining_recovery_codes,
    })


@login_required
def change_password_view(request):
    """Change account password requiring current password validation."""
    user = request.user

    if request.method == 'POST':
        form = ChangePasswordDashboardForm(user, request.POST)
        if form.is_valid():
            new_password = form.cleaned_data['new_password1']
            user.set_password(new_password)
            user.password_changed_at = timezone.now()
            user.save()

            # Keep user logged in with current session
            update_session_auth_hash(request, user)

            # Invalidate other devices
            revoke_all_other_sessions(user, request.session.session_key)
            track_user_session(user, request)

            log_security_event(user, SecurityEvent.EventType.PASSWORD_CHANGED, request)
            send_password_changed_notification(user, request)

            messages.success(request, 'Your password has been changed successfully. Other active sessions were logged out for security.')
            return redirect('security_center')
    else:
        form = ChangePasswordDashboardForm(user)

    return render(request, 'users/change_password.html', {'form': form})


@login_required
def two_factor_setup_view(request):
    """Setup TOTP 2FA: Display QR code, verify initial code, generate recovery codes."""
    user = request.user

    if user.two_factor_enabled:
        messages.info(request, 'Two-Factor Authentication is already enabled on your account.')
        return redirect('security_center')

    # Step 1: Generate or retrieve staged secret from session
    staged_secret = request.session.get('staged_2fa_secret')
    if not staged_secret:
        staged_secret = generate_totp_secret()
        request.session['staged_2fa_secret'] = staged_secret

    totp_uri = get_totp_uri(user, staged_secret)
    qr_data_uri = generate_qr_code_data_uri(totp_uri)

    if request.method == 'POST':
        form = TwoFactorSetupConfirmForm(request.POST)
        if form.is_valid():
            code = form.cleaned_data['code']
            if verify_totp_code(staged_secret, code):
                # Save TOTP secret and activate 2FA
                user.totp_secret = staged_secret
                user.two_factor_enabled = True
                user.save(update_fields=['totp_secret', 'two_factor_enabled'])

                request.session.pop('staged_2fa_secret', None)

                # Generate 10 single-use recovery codes
                recovery_codes = generate_recovery_codes(user)
                request.session['revealed_recovery_codes'] = recovery_codes

                log_security_event(user, SecurityEvent.EventType.TWO_FACTOR_ENABLED, request)
                send_2fa_enabled_notification(user, request)

                messages.success(request, 'Two-Factor Authentication has been successfully enabled!')
                return redirect('two_factor_recovery_codes_show')
            else:
                messages.error(request, 'Invalid 6-digit code. Please verify the code on your authenticator app.')
    else:
        form = TwoFactorSetupConfirmForm()

    return render(request, 'users/2fa_setup.html', {
        'form': form,
        'secret': staged_secret,
        'qr_data_uri': qr_data_uri,
    })


@login_required
def two_factor_recovery_codes_show_view(request):
    """Display generated recovery codes once with download option."""
    codes = request.session.get('revealed_recovery_codes')
    if not codes:
        return redirect('security_center')

    return render(request, 'users/2fa_recovery_codes_show.html', {
        'recovery_codes': codes,
    })


@login_required
def two_factor_regenerate_codes_view(request):
    """Regenerate 10 fresh recovery codes, invalidating all old ones."""
    user = request.user
    if not user.two_factor_enabled:
        messages.error(request, 'Two-Factor Authentication must be enabled to generate recovery codes.')
        return redirect('security_center')

    if request.method == 'POST':
        codes = generate_recovery_codes(user)
        request.session['revealed_recovery_codes'] = codes
        log_security_event(user, SecurityEvent.EventType.RECOVERY_CODES_REGENERATED, request)
        messages.success(request, 'New recovery codes generated. Previous recovery codes are now invalid.')
        return redirect('two_factor_recovery_codes_show')

    return render(request, 'users/2fa_regenerate_confirm.html')


@login_required
def two_factor_disable_view(request):
    """Disable 2FA requiring current password and current TOTP code."""
    user = request.user
    if not user.two_factor_enabled:
        messages.info(request, 'Two-Factor Authentication is not enabled.')
        return redirect('security_center')

    if request.method == 'POST':
        form = TwoFactorDisableForm(user, request.POST)
        if form.is_valid():
            code = form.cleaned_data['code']
            if verify_totp_code(user.totp_secret, code):
                user.two_factor_enabled = False
                user.totp_secret = None
                user.save(update_fields=['two_factor_enabled', 'totp_secret'])

                # Invalidate all recovery codes
                TwoFactorRecoveryCode.objects.filter(user=user).delete()

                log_security_event(user, SecurityEvent.EventType.TWO_FACTOR_DISABLED, request)
                send_2fa_disabled_notification(user, request)

                messages.warning(request, 'Two-Factor Authentication has been disabled on your account.')
                return redirect('security_center')
            else:
                messages.error(request, 'Invalid authenticator code.')
    else:
        form = TwoFactorDisableForm(user)

    return render(request, 'users/2fa_disable.html', {'form': form})


@login_required
def manage_sessions_view(request):
    """Manage active logged-in sessions and devices."""
    user = request.user
    current_key = request.session.session_key
    track_user_session(user, request)

    sessions = UserSession.objects.filter(user=user)
    return render(request, 'users/manage_sessions.html', {
        'sessions': sessions,
        'current_session_key': current_key,
    })


@login_required
def revoke_all_sessions_view(request):
    """Log out of all other devices except current browser."""
    if request.method == 'POST':
        user = request.user
        current_key = request.session.session_key
        revoke_all_other_sessions(user, current_key)
        log_security_event(user, SecurityEvent.EventType.ALL_SESSIONS_REVOKED, request)
        messages.success(request, 'Successfully logged out of all other devices.')
    return redirect('manage_sessions')
