from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as BaseUserAdmin
from .models import CustomUser, SecurityEvent, TwoFactorRecoveryCode, UserSession


@admin.register(CustomUser)
class CustomUserAdmin(BaseUserAdmin):
    list_display = [
        'email', 'full_name', 'phone_number', 'user_type',
        'email_verified', 'two_factor_enabled', 'is_staff', 'is_active', 'date_joined'
    ]
    list_filter = ['user_type', 'email_verified', 'two_factor_enabled', 'is_staff', 'is_active', 'date_joined']
    search_fields = ['email', 'full_name', 'phone_number', 'recovery_email']
    ordering = ['-date_joined']

    fieldsets = (
        (None, {'fields': ('email', 'password')}),
        ('Personal info', {'fields': ('full_name', 'phone_number', 'user_type', 'recovery_email')}),
        ('Security & 2FA', {'fields': ('email_verified', 'two_factor_enabled', 'totp_secret', 'password_changed_at')}),
        ('Permissions', {'fields': ('is_active', 'is_staff', 'is_superuser', 'groups', 'user_permissions')}),
        ('Important dates', {'fields': ('last_login', 'date_joined')}),
    )

    add_fieldsets = (
        (None, {
            'classes': ('wide',),
            'fields': (
                'email', 'full_name', 'phone_number', 'user_type',
                'recovery_email', 'email_verified', 'password1', 'password2'
            ),
        }),
    )


@admin.register(SecurityEvent)
class SecurityEventAdmin(admin.ModelAdmin):
    list_display = ['created_at', 'user', 'event_type', 'ip_address']
    list_filter = ['event_type', 'created_at']
    search_fields = ['user__email', 'ip_address', 'user_agent']
    readonly_fields = ['user', 'event_type', 'ip_address', 'user_agent', 'created_at']

    def has_add_permission(self, request):
        return False


@admin.register(TwoFactorRecoveryCode)
class TwoFactorRecoveryCodeAdmin(admin.ModelAdmin):
    list_display = ['user', 'is_used', 'created_at', 'used_at']
    list_filter = ['is_used', 'created_at']
    search_fields = ['user__email']
    readonly_fields = ['user', 'code_hash', 'created_at', 'used_at', 'is_used']

    def has_add_permission(self, request):
        return False


@admin.register(UserSession)
class UserSessionAdmin(admin.ModelAdmin):
    list_display = ['user', 'device_name', 'ip_address', 'last_activity', 'created_at']
    search_fields = ['user__email', 'ip_address', 'device_name']
    readonly_fields = ['user', 'session_key', 'ip_address', 'user_agent', 'device_name', 'last_activity', 'created_at']
