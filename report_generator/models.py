import uuid

from django.db import models


class Report(models.Model):
    """
    One generated PDF report. Owned by a Supabase user id (the JWT `sub`),
    looked up as (id, owner_id) so a guessed id alone never grants access.
    PDF bytes live in the row so there are no user-influenced file paths;
    rows expire after REPORT_RETENTION_HOURS and are purged by
    services.purge_expired() / `manage.py cleanup_reports`.
    """
    QUEUED, RUNNING, SUCCEEDED, FAILED = 'queued', 'running', 'succeeded', 'failed'
    STATUS_CHOICES = [(s, s) for s in (QUEUED, RUNNING, SUCCEEDED, FAILED)]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner_id = models.CharField(max_length=64, db_index=True)
    source = models.CharField(max_length=16, default='dashboard')
    status = models.CharField(max_length=12, choices=STATUS_CHOICES, default=QUEUED, db_index=True)
    stage = models.CharField(max_length=32, blank=True, default='')
    completed_stages = models.JSONField(default=list)
    error_message = models.CharField(max_length=300, blank=True, default='')

    SINGLE, FAVORITES = 'single', 'favorites'
    KIND_CHOICES = [(SINGLE, 'Single location'), (FAVORITES, 'Favorites comparison')]
    kind = models.CharField(max_length=16, choices=KIND_CHOICES, default=SINGLE)
    # Favorites reports: the saved places (name, category, lat/lon, address) analysed.
    places = models.JSONField(default=list, blank=True)

    location_name = models.CharField(max_length=200)
    address = models.CharField(max_length=255, blank=True, default='')
    latitude = models.FloatField()
    longitude = models.FloatField()
    radius_m = models.PositiveIntegerField()
    business_type = models.CharField(max_length=60, blank=True, default='')

    # Validated, re-encoded PNG of the live heatmap; cleared once the PDF is built.
    screenshot = models.BinaryField(null=True, blank=True)
    capture_meta = models.JSONField(default=dict)

    pdf = models.BinaryField(null=True, blank=True)
    pdf_size = models.PositiveIntegerField(default=0)
    page_count = models.PositiveIntegerField(default=0)
    ai_used = models.BooleanField(default=False)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    expires_at = models.DateTimeField(db_index=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f'Report {self.id} ({self.status})'
