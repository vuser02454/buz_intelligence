"""
TOTP Two-Factor Authentication and Backup Recovery Code utilities.
"""
import base64
import io
import secrets
import string
import pyotp
import qrcode
from django.contrib.auth.hashers import check_password, make_password
from django.utils import timezone

from .models import TwoFactorRecoveryCode


def generate_totp_secret() -> str:
    """Generate a high-entropy base32 secret for TOTP."""
    return pyotp.random_base32()


def get_totp_uri(user, secret: str) -> str:
    """Generate standard otpauth:// provisioning URI for authenticator apps."""
    totp = pyotp.TOTP(secret)
    return totp.provisioning_uri(name=user.email, issuer_name='Crowd Heatmap')


def generate_qr_code_data_uri(totp_uri: str) -> str:
    """Generate a Base64-encoded PNG Data URI for the TOTP QR Code."""
    qr = qrcode.QRCode(
        version=1,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=8,
        border=3,
    )
    qr.add_data(totp_uri)
    qr.make(fit=True)

    img = qr.make_image(fill_color="#0b0c10", back_color="#ffffff")
    buffer = io.BytesIO()
    img.save(buffer, format='PNG')
    encoded = base64.b64encode(buffer.getvalue()).decode('utf-8')
    return f"data:image/png;base64,{encoded}"


def verify_totp_code(secret: str, code: str) -> bool:
    """Verify a 6-digit TOTP code with standard ±1 time-step window for clock drift."""
    if not secret or not code:
        return False
    # Clean code: digits only
    clean_code = ''.join(c for c in str(code) if c.isdigit())
    if len(clean_code) != 6:
        return False
    totp = pyotp.TOTP(secret)
    return bool(totp.verify(clean_code, valid_window=1))


def generate_recovery_codes(user) -> list[str]:
    """
    Generate 10 single-use recovery codes formatted as 'XXXX-XXXX'.
    Invalidates any previous recovery codes and stores only hashed codes in the database.
    Returns the list of plaintext codes to be shown to the user once.
    """
    # Delete old recovery codes
    TwoFactorRecoveryCode.objects.filter(user=user).delete()

    chars = string.ascii_uppercase + string.digits
    # Exclude ambiguous characters (0, O, 1, I)
    safe_chars = ''.join(c for c in chars if c not in '0O1I')

    plain_codes = []
    db_objects = []

    for _ in range(10):
        part1 = ''.join(secrets.choice(safe_chars) for _ in range(4))
        part2 = ''.join(secrets.choice(safe_chars) for _ in range(4))
        code = f"{part1}-{part2}"
        plain_codes.append(code)

        db_objects.append(
            TwoFactorRecoveryCode(
                user=user,
                code_hash=make_password(code.replace('-', '').upper()),
                is_used=False,
            )
        )

    TwoFactorRecoveryCode.objects.bulk_create(db_objects)
    return plain_codes


def verify_recovery_code(user, plain_code: str) -> bool:
    """
    Verify and consume a single-use backup recovery code.
    Matches case-insensitively and ignores hyphens/spaces.
    """
    if not user or not plain_code:
        return False

    normalized = ''.join(c for c in str(plain_code) if c.isalnum()).upper()
    if not normalized:
        return False

    unused_codes = TwoFactorRecoveryCode.objects.filter(user=user, is_used=False)
    for rc in unused_codes:
        if check_password(normalized, rc.code_hash):
            rc.is_used = True
            rc.used_at = timezone.now()
            rc.save(update_fields=['is_used', 'used_at'])
            return True

    return False
