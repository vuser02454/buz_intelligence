"""
Authentication, Registration, 2FA, and Account Recovery Forms.
"""
from django import forms
from django.contrib.auth import authenticate
from django.contrib.auth.forms import (
    PasswordResetForm,
    SetPasswordForm,
)
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from .models import CustomUser, UserType


class LoginForm(forms.Form):
    """Clean login form with email normalization and verification check."""
    email = forms.EmailField(
        label='Email Address',
        widget=forms.EmailInput(attrs={
            'class': 'form-control form-control-custom',
            'placeholder': 'name@example.com',
            'autocomplete': 'email',
            'id': 'id_email',
        }),
    )
    password = forms.CharField(
        label='Password',
        widget=forms.PasswordInput(attrs={
            'class': 'form-control form-control-custom',
            'placeholder': 'Enter your password',
            'autocomplete': 'current-password',
            'id': 'id_password',
        }),
    )
    remember_me = forms.BooleanField(
        required=False,
        label='Remember me',
        widget=forms.CheckboxInput(attrs={'class': 'form-check-input'}),
    )

    def clean_email(self):
        return self.cleaned_data.get('email', '').strip().lower()

    def clean(self):
        cleaned_data = super().clean()
        email = cleaned_data.get('email')
        password = cleaned_data.get('password')

        if email and password:
            self.user = authenticate(username=email, password=password)
            if self.user is None:
                raise ValidationError(
                    'Invalid email or password. Please check your credentials and try again.',
                    code='invalid_login',
                )
            if not self.user.is_active:
                raise ValidationError(
                    'This account is currently inactive. Please contact support.',
                    code='inactive',
                )
            if not getattr(self.user, 'email_verified', False):
                self.unverified_email = email
                raise ValidationError(
                    'Your email address has not been verified yet. Please check your inbox or request a new verification email.',
                    code='unverified',
                )
        return cleaned_data

    def get_user(self):
        return getattr(self, 'user', None)


class UserCreationForm(forms.ModelForm):
    """Secure registration form with optional recovery email."""
    password = forms.CharField(
        label='Password',
        widget=forms.PasswordInput(attrs={
            'class': 'form-control form-control-custom',
            'placeholder': 'Create a strong password',
            'autocomplete': 'new-password',
            'id': 'id_password',
        }),
    )
    confirm_password = forms.CharField(
        label='Confirm Password',
        widget=forms.PasswordInput(attrs={
            'class': 'form-control form-control-custom',
            'placeholder': 'Confirm your password',
            'autocomplete': 'new-password',
            'id': 'id_confirm_password',
        }),
    )

    class Meta:
        model = CustomUser
        fields = ['full_name', 'email', 'recovery_email', 'phone_number', 'user_type']
        widgets = {
            'full_name': forms.TextInput(attrs={
                'class': 'form-control form-control-custom',
                'placeholder': 'Full Name',
                'id': 'id_full_name',
            }),
            'email': forms.EmailInput(attrs={
                'class': 'form-control form-control-custom',
                'placeholder': 'name@example.com',
                'id': 'id_email',
            }),
            'recovery_email': forms.EmailInput(attrs={
                'class': 'form-control form-control-custom',
                'placeholder': 'recovery@example.com (Optional)',
                'id': 'id_recovery_email',
            }),
            'phone_number': forms.TextInput(attrs={
                'class': 'form-control form-control-custom',
                'placeholder': '+1 (555) 000-0000',
                'id': 'id_phone_number',
            }),
            'user_type': forms.Select(attrs={
                'class': 'form-select form-select-custom',
                'id': 'id_user_type',
            }),
        }

    def clean_email(self):
        return self.cleaned_data.get('email', '').strip().lower()

    def clean_recovery_email(self):
        rec = self.cleaned_data.get('recovery_email', '')
        return rec.strip().lower() if rec else None

    def clean(self):
        cleaned_data = super().clean()
        password = cleaned_data.get('password')
        confirm_password = cleaned_data.get('confirm_password')

        if password and confirm_password:
            if password != confirm_password:
                self.add_error('confirm_password', 'Passwords do not match.')
            else:
                validate_password(password)

        email = cleaned_data.get('email')
        recovery_email = cleaned_data.get('recovery_email')
        if email and recovery_email and email == recovery_email:
            self.add_error('recovery_email', 'Recovery email cannot be identical to primary email.')

        return cleaned_data

    def save(self, commit=True):
        user = super().save(commit=False)
        user.set_password(self.cleaned_data['password'])
        user.email_verified = False
        user.two_factor_enabled = False
        if commit:
            user.save()
        return user


class ResendVerificationForm(forms.Form):
    """Resend email verification request form."""
    email = forms.EmailField(
        label='Email Address',
        widget=forms.EmailInput(attrs={
            'class': 'form-control form-control-custom',
            'placeholder': 'name@example.com',
            'autocomplete': 'email',
            'id': 'id_resend_email',
        }),
    )

    def clean_email(self):
        return self.cleaned_data.get('email', '').strip().lower()


class ForgotEmailForm(forms.Form):
    """Account recovery lookup form via recovery email or phone number."""
    identifier = forms.CharField(
        label='Recovery Email or Registered Phone Number',
        widget=forms.TextInput(attrs={
            'class': 'form-control form-control-custom',
            'placeholder': 'Enter your recovery email or phone number',
            'id': 'id_identifier',
        }),
    )

    def clean_identifier(self):
        return self.cleaned_data.get('identifier', '').strip()


class CustomPasswordResetForm(PasswordResetForm):
    """Custom styled password reset request form."""
    email = forms.EmailField(
        label='Email Address',
        widget=forms.EmailInput(attrs={
            'class': 'form-control form-control-custom',
            'placeholder': 'name@example.com',
            'autocomplete': 'email',
            'id': 'id_reset_email',
        }),
    )

    def clean_email(self):
        return self.cleaned_data.get('email', '').strip().lower()


class CustomSetPasswordForm(SetPasswordForm):
    """Custom styled set new password form."""
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        for field in self.fields.values():
            field.widget.attrs.update({
                'class': 'form-control form-control-custom',
            })


class ChangePasswordDashboardForm(forms.Form):
    """Form to change password from dashboard, requiring current password."""
    current_password = forms.CharField(
        label='Current Password',
        widget=forms.PasswordInput(attrs={
            'class': 'form-control form-control-custom',
            'placeholder': 'Enter current password',
            'autocomplete': 'current-password',
            'id': 'id_current_password',
        }),
    )
    new_password1 = forms.CharField(
        label='New Password',
        widget=forms.PasswordInput(attrs={
            'class': 'form-control form-control-custom',
            'placeholder': 'Enter new password',
            'autocomplete': 'new-password',
            'id': 'id_new_password1',
        }),
    )
    new_password2 = forms.CharField(
        label='Confirm New Password',
        widget=forms.PasswordInput(attrs={
            'class': 'form-control form-control-custom',
            'placeholder': 'Confirm new password',
            'autocomplete': 'new-password',
            'id': 'id_new_password2',
        }),
    )

    def __init__(self, user, *args, **kwargs):
        self.user = user
        super().__init__(*args, **kwargs)

    def clean_current_password(self):
        current_password = self.cleaned_data.get('current_password')
        if not self.user.check_password(current_password):
            raise ValidationError('Your current password was entered incorrectly.')
        return current_password

    def clean(self):
        cleaned_data = super().clean()
        new_password1 = cleaned_data.get('new_password1')
        new_password2 = cleaned_data.get('new_password2')

        if new_password1 and new_password2:
            if new_password1 != new_password2:
                self.add_error('new_password2', 'New passwords do not match.')
            else:
                validate_password(new_password1, user=self.user)
        return cleaned_data


class TwoFactorVerifyForm(forms.Form):
    """Form to submit 6-digit TOTP code during login or verification."""
    code = forms.CharField(
        label='6-Digit Authenticator Code',
        max_length=6,
        widget=forms.TextInput(attrs={
            'class': 'form-control form-control-custom text-center',
            'placeholder': '123456',
            'autocomplete': 'one-time-code',
            'inputmode': 'numeric',
            'pattern': '[0-9]*',
            'maxlength': '6',
            'id': 'id_totp_code',
            'style': 'letter-spacing: 6px; font-size: 24px; font-weight: bold;',
        }),
    )

    def clean_code(self):
        code = self.cleaned_data.get('code', '').strip()
        clean = ''.join(c for c in code if c.isdigit())
        if len(clean) != 6:
            raise ValidationError('Please enter a valid 6-digit numeric code.')
        return clean


class TwoFactorRecoveryCodeForm(forms.Form):
    """Form to submit backup recovery code when authenticator is lost."""
    recovery_code = forms.CharField(
        label='Backup Recovery Code',
        max_length=20,
        widget=forms.TextInput(attrs={
            'class': 'form-control form-control-custom text-center',
            'placeholder': 'XXXX-XXXX',
            'autocomplete': 'off',
            'id': 'id_recovery_code',
            'style': 'letter-spacing: 3px; font-size: 20px; text-transform: uppercase;',
        }),
    )

    def clean_recovery_code(self):
        code = self.cleaned_data.get('recovery_code', '').strip().upper()
        clean = ''.join(c for c in code if c.isalnum())
        if len(clean) < 6:
            raise ValidationError('Please enter a valid recovery code.')
        return clean


class TwoFactorDisableForm(forms.Form):
    """Form to disable 2FA, requiring current password and current TOTP code."""
    current_password = forms.CharField(
        label='Current Password',
        widget=forms.PasswordInput(attrs={
            'class': 'form-control form-control-custom',
            'placeholder': 'Enter your current password',
            'id': 'id_disable_password',
        }),
    )
    code = forms.CharField(
        label='Current 6-Digit Authenticator Code',
        max_length=6,
        widget=forms.TextInput(attrs={
            'class': 'form-control form-control-custom text-center',
            'placeholder': '123456',
            'autocomplete': 'one-time-code',
            'inputmode': 'numeric',
            'pattern': '[0-9]*',
            'maxlength': '6',
            'id': 'id_disable_code',
            'style': 'letter-spacing: 4px; font-weight: bold;',
        }),
    )

    def __init__(self, user, *args, **kwargs):
        self.user = user
        super().__init__(*args, **kwargs)

    def clean_current_password(self):
        current_password = self.cleaned_data.get('current_password')
        if not self.user.check_password(current_password):
            raise ValidationError('Incorrect current password.')
        return current_password

    def clean_code(self):
        code = self.cleaned_data.get('code', '').strip()
        clean = ''.join(c for c in code if c.isdigit())
        if len(clean) != 6:
            raise ValidationError('Please enter a valid 6-digit code.')
        return clean


class TwoFactorSetupConfirmForm(forms.Form):
    """Form to verify initial TOTP setup code."""
    code = forms.CharField(
        label='6-Digit Code from Authenticator App',
        max_length=6,
        widget=forms.TextInput(attrs={
            'class': 'form-control form-control-custom text-center',
            'placeholder': '000000',
            'autocomplete': 'one-time-code',
            'inputmode': 'numeric',
            'pattern': '[0-9]*',
            'maxlength': '6',
            'id': 'id_setup_code',
            'style': 'letter-spacing: 6px; font-size: 22px; font-weight: bold;',
        }),
    )

    def clean_code(self):
        code = self.cleaned_data.get('code', '').strip()
        clean = ''.join(c for c in code if c.isdigit())
        if len(clean) != 6:
            raise ValidationError('Please enter a valid 6-digit code.')
        return clean
