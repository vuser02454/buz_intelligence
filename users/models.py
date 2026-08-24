from django.contrib.auth.models import AbstractUser, BaseUserManager
from django.db import models


class CustomUserManager(BaseUserManager):
    """Custom user manager where email is the unique identifier for authentication."""

    def create_user(self, email, password=None, **extra_fields):
        if not email:
            raise ValueError('The Email field must be set')
        email = self.normalize_email(email)
        user = self.model(email=email, **extra_fields)
        user.set_password(password)  # Django handles hashing
        user.save(using=self._db)
        return user

    def create_superuser(self, email, password=None, **extra_fields):
        extra_fields.setdefault('is_staff', True)
        extra_fields.setdefault('is_superuser', True)
        extra_fields.setdefault('is_active', True)
        if extra_fields.get('is_staff') is not True:
            raise ValueError('Superuser must have is_staff=True.')
        if extra_fields.get('is_superuser') is not True:
            raise ValueError('Superuser must have is_superuser=True.')
        return self.create_user(email, password, **extra_fields)


class UserType(models.TextChoices):
    """User type choices - stored in database as text values."""
    BUSINESSMAN = 'businessman', 'Businessman'
    CUSTOMER = 'customer', 'Customer'


class CustomUser(AbstractUser):
    """
    Custom User model using email as the unique identifier.
    Username field is removed; email is used for authentication.
    """
    username = None  # Remove username field

    objects = CustomUserManager()

    email = models.EmailField('email address', unique=True)
    full_name = models.CharField('full name', max_length=150)
    phone_number = models.CharField('phone number', max_length=20)
    user_type = models.CharField(
        'user type',
        max_length=20,
        choices=UserType.choices,
        default=UserType.CUSTOMER,
    )
    email_verified = models.BooleanField(
        'email verified',
        default=False,
        help_text='Designates whether this user has verified their email address.',
    )

    # Security & Recovery fields
    recovery_email = models.EmailField(
        'recovery email',
        blank=True,
        null=True,
        help_text='Secondary email address for account recovery.',
    )
    two_factor_enabled = models.BooleanField(
        '2FA enabled',
        default=False,
        help_text='Designates whether two-factor authentication is active.',
    )
    totp_secret = models.CharField(
        'TOTP secret',
        max_length=64,
        blank=True,
        null=True,
        help_text='Base32 encoded secret key for TOTP 2FA.',
    )
    password_changed_at = models.DateTimeField(
        'password last changed',
        blank=True,
        null=True,
        help_text='Timestamp of the last password update.',
    )

    USERNAME_FIELD = 'email'
    REQUIRED_FIELDS = ['full_name', 'phone_number', 'user_type']

    class Meta:
        verbose_name = 'user'
        verbose_name_plural = 'users'

    def __str__(self):
        return self.email


class TwoFactorRecoveryCode(models.Model):
    """
    Stores hashed, single-use recovery backup codes for 2FA.
    Never stores plaintext recovery codes.
    """
    user = models.ForeignKey(
        CustomUser,
        on_delete=models.CASCADE,
        related_name='recovery_codes',
    )
    code_hash = models.CharField(
        'code hash',
        max_length=128,
        help_text='Hashed representation of the recovery code.',
    )
    created_at = models.DateTimeField(auto_now_add=True)
    used_at = models.DateTimeField(null=True, blank=True)
    is_used = models.BooleanField(default=False)

    class Meta:
        verbose_name = '2FA recovery code'
        verbose_name_plural = '2FA recovery codes'
        ordering = ['-created_at']

    def __str__(self):
        status = 'Used' if self.is_used else 'Active'
        return f"Recovery code for {self.user.email} ({status})"


class SecurityEvent(models.Model):
    """
    Audit log for user security actions (never logs credentials, tokens, or plain codes).
    """
    class EventType(models.TextChoices):
        LOGIN = 'LOGIN', 'Successful Login'
        LOGOUT = 'LOGOUT', 'User Logout'
        PASSWORD_CHANGED = 'PASSWORD_CHANGED', 'Password Changed'
        PASSWORD_RESET = 'PASSWORD_RESET', 'Password Reset Completed'
        EMAIL_VERIFIED = 'EMAIL_VERIFIED', 'Email Address Verified'
        TWO_FACTOR_ENABLED = '2FA_ENABLED', 'Two-Factor Authentication Enabled'
        TWO_FACTOR_DISABLED = '2FA_DISABLED', 'Two-Factor Authentication Disabled'
        RECOVERY_CODE_USED = 'RECOVERY_CODE_USED', '2FA Recovery Code Used'
        RECOVERY_CODES_REGENERATED = 'RECOVERY_CODES_REGENERATED', '2FA Recovery Codes Regenerated'
        FAILED_2FA_ATTEMPT = 'FAILED_2FA_ATTEMPT', 'Failed 2FA Attempt'
        ACCOUNT_RECOVERY = 'ACCOUNT_RECOVERY', 'Account Recovery Initiated'
        ALL_SESSIONS_REVOKED = 'ALL_SESSIONS_REVOKED', 'All Other Sessions Revoked'

    user = models.ForeignKey(
        CustomUser,
        on_delete=models.CASCADE,
        related_name='security_events',
    )
    event_type = models.CharField(
        'event type',
        max_length=50,
        choices=EventType.choices,
    )
    ip_address = models.GenericIPAddressField('IP address', null=True, blank=True)
    user_agent = models.TextField('user agent', blank=True, null=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        verbose_name = 'security event'
        verbose_name_plural = 'security events'
        ordering = ['-created_at']

    def __str__(self):
        return f"[{self.created_at.strftime('%Y-%m-%d %H:%M')}] {self.user.email} - {self.get_event_type_display()}"


class UserSession(models.Model):
    """
    Tracks active user devices/sessions to allow selective revocation and 'log out of all other devices'.
    """
    user = models.ForeignKey(
        CustomUser,
        on_delete=models.CASCADE,
        related_name='active_sessions',
    )
    session_key = models.CharField('session key', max_length=40, unique=True)
    ip_address = models.GenericIPAddressField('IP address', null=True, blank=True)
    user_agent = models.TextField('user agent', blank=True, null=True)
    device_name = models.CharField('device name', max_length=100, default='Web Browser')
    last_activity = models.DateTimeField(auto_now=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        verbose_name = 'active session'
        verbose_name_plural = 'active sessions'
        ordering = ['-last_activity']

    def __str__(self):
        return f"{self.user.email} - {self.device_name} ({self.ip_address})"
