from django.urls import path

from report_generator.views import generate_favorites_report

from . import views

urlpatterns = [
    path('favorites/', views.favorites_page, name='favorites'),
    path('api/favorites/', views.favorites_collection, name='favorites_collection'),
    path('api/favorites/toggle/', views.favorite_toggle, name='favorite_toggle'),
    # Full-detail favorites PDF: queued as a stored report (see report_generator.favorites_report).
    path('api/favorites/report/', generate_favorites_report, name='favorites_report'),
    path('api/favorites/recommendations/', views.recommendations, name='favorite_recommendations'),
    path('api/favorites/<int:pk>/', views.favorite_detail, name='favorite_detail'),
]
