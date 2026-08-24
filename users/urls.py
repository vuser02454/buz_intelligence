"""
URL routing configuration for user authentication, 2FA, password recovery,
account recovery, and security dashboard.
"""
from django.urls import path
from . import views

urlpatterns = [
    # Registration & Verification
    path('register/', views.register_view, name='register'),
    path('login/', views.login_view, name='login'),
    path('logout/', views.logout_view, name='logout'),
    path('verify-email/', views.verify_email_sent_view, name='verify_email_sent'),
    path('verify-email/<str:uidb64>/<str:token>/', views.verify_email_confirm_view, name='verify_email_confirm'),
    path('resend-verification/', views.resend_verification_view, name='resend_verification'),

    # Two-Factor Authentication Login Challenge & Backup Recovery Code
    path('2fa/', views.two_factor_verify_view, name='two_factor_verify'),
    path('2fa/recovery/', views.two_factor_recovery_view, name='two_factor_recovery'),

    # Forgot Email / Account Recovery
    path('forgot-email/', views.forgot_email_view, name='forgot_email'),

    # Password Reset
    path('password-reset/', views.CustomPasswordResetView.as_view(), name='password_reset'),
    path('password-reset/done/', views.CustomPasswordResetDoneView.as_view(), name='password_reset_done'),
    path('password-reset/<str:uidb64>/<str:token>/', views.CustomPasswordResetConfirmView.as_view(), name='password_reset_confirm'),
    path('password-reset/complete/', views.CustomPasswordResetCompleteView.as_view(), name='password_reset_complete'),

    # Dashboard Security Center & Account Management
    path('security/', views.security_center_view, name='security_center'),
    path('security/change-password/', views.change_password_view, name='change_password'),
    path('security/2fa/setup/', views.two_factor_setup_view, name='two_factor_setup'),
    path('security/2fa/recovery-codes/', views.two_factor_recovery_codes_show_view, name='two_factor_recovery_codes_show'),
    path('security/2fa/regenerate-codes/', views.two_factor_regenerate_codes_view, name='two_factor_regenerate_codes'),
    path('security/2fa/disable/', views.two_factor_disable_view, name='two_factor_disable'),
    path('security/sessions/', views.manage_sessions_view, name='manage_sessions'),
    path('security/sessions/revoke-all/', views.revoke_all_sessions_view, name='revoke_all_sessions'),
]
