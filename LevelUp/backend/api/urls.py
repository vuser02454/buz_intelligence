from django.urls import path, include
from rest_framework.routers import DefaultRouter
from rest_framework_simplejwt.views import (
    TokenObtainPairView,
    TokenRefreshView,
)
from .views import (
    RegisterView, UserProfileView, ActivityViewSet,
    SkillViewSet, JournalEntryViewSet, WebhookView,
    ImportCSVView, DailyCheckInViewSet
)

router = DefaultRouter()
router.register(r'activities', ActivityViewSet, basename='activity')
router.register(r'skills', SkillViewSet, basename='skill')
router.register(r'journal', JournalEntryViewSet, basename='journal')
router.register(r'checkins', DailyCheckInViewSet, basename='checkin')


urlpatterns = [
    # Auth
    path('auth/register/', RegisterView.as_view(), name='register'),
    path('auth/login/', TokenObtainPairView.as_view(), name='token_obtain_pair'),
    path('auth/refresh/', TokenRefreshView.as_view(), name='token_refresh'),
    path('auth/me/', UserProfileView.as_view(), name='me'),
    
    # Webhooks & Integrations
    path('webhook/habit-completed/', WebhookView.as_view(), name='webhook_habit'),
    path('activities/import/', ImportCSVView.as_view(), name='import_csv'),

    # App features
    path('', include(router.urls)),
]
