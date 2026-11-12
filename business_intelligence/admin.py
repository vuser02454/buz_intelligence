from django.contrib import admin
from .models import BusinessUser

@admin.register(BusinessUser)
class BusinessUserAdmin(admin.ModelAdmin):
    list_display = ['name', 'email', 'business_type', 'crowd_intensity', 'created_at']
    list_filter = ['crowd_intensity', 'created_at']
    search_fields = ['name', 'email', 'business_type']

