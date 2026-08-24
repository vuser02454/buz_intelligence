"""
Cache-backed rate limiting utility to protect critical authentication and recovery endpoints.
"""
import time
from functools import wraps
from django.core.cache import cache
from django.http import HttpResponse


def get_client_ip(request) -> str:
    """Extract real client IP address from request headers."""
    x_forwarded_for = request.META.get('HTTP_X_FORWARDED_FOR')
    if x_forwarded_for:
        ip = x_forwarded_for.split(',')[0].strip()
    else:
        ip = request.META.get('REMOTE_ADDR', '127.0.0.1')
    return ip


def check_rate_limit(
    request,
    action: str,
    max_requests: int = 5,
    window_seconds: int = 300,
    identifier: str = None,
) -> bool:
    """
    Check and increment rate limit for an action.
    Returns True if request is allowed, False if rate limit is exceeded.
    """
    ip = get_client_ip(request)
    key_id = identifier or ip
    cache_key = f"rl:{action}:{key_id}"

    history = cache.get(cache_key, [])
    now = time.time()

    # Filter out entries older than window
    valid_history = [t for t in history if (now - t) < window_seconds]

    if len(valid_history) >= max_requests:
        return False

    valid_history.append(now)
    cache.set(cache_key, valid_history, timeout=window_seconds)
    return True


def rate_limit_required(
    action: str,
    max_requests: int = 5,
    window_seconds: int = 300,
    error_message: str = "Too many requests. Please wait a few minutes before trying again.",
):
    """
    Decorator to apply rate limiting on view functions.
    """
    def decorator(view_func):
        @wraps(view_func)
        def _wrapped_view(request, *args, **kwargs):
            if request.method == 'POST':
                allowed = check_rate_limit(
                    request,
                    action=action,
                    max_requests=max_requests,
                    window_seconds=window_seconds,
                )
                if not allowed:
                    from django.contrib import messages
                    from django.shortcuts import redirect
                    messages.error(request, error_message)
                    return redirect(request.path)
            return view_func(request, *args, **kwargs)
        return _wrapped_view
    return decorator
