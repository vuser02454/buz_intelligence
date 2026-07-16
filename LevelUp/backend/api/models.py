import uuid
from django.db import models
from django.contrib.auth.models import AbstractUser
from django.utils.translation import gettext_lazy as _

class User(AbstractUser):
    pass

class Profile(models.Model):
    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name='profile')
    webhook_token = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    level = models.PositiveIntegerField(default=1)
    xp = models.PositiveIntegerField(default=0)
    coins = models.PositiveIntegerField(default=0)
    rank = models.CharField(max_length=50, default='Novice')
    daily_quote = models.CharField(max_length=255, blank=True)
    current_streak = models.PositiveIntegerField(default=0)
    
    # Core Stats
    knowledge = models.PositiveIntegerField(default=0)
    charm = models.PositiveIntegerField(default=0)
    guts = models.PositiveIntegerField(default=0)
    kindness = models.PositiveIntegerField(default=0)
    proficiency = models.PositiveIntegerField(default=0)

    def __str__(self):
        return f"{self.user.username}'s Profile"

class Activity(models.Model):
    class Category(models.TextChoices):
        STUDY = 'study', _('Study')
        CODING = 'coding', _('Coding')
        READING = 'reading', _('Reading')
        GYM = 'gym', _('Gym')
        MEDITATION = 'meditation', _('Meditation')
        BUSINESS = 'business', _('Business')
        LANGUAGE = 'language', _('Language Learning')
        CREATIVE = 'creative', _('Creative Work')
        SOCIAL = 'social', _('Social')
        CUSTOM = 'custom', _('Custom')
        
    class Difficulty(models.TextChoices):
        EASY = 'easy', _('Easy')
        MEDIUM = 'medium', _('Medium')
        HARD = 'hard', _('Hard')
        
    class StatTarget(models.TextChoices):
        KNOWLEDGE = 'knowledge', _('Knowledge')
        CHARM = 'charm', _('Charm')
        GUTS = 'guts', _('Guts')
        KINDNESS = 'kindness', _('Kindness')
        PROFICIENCY = 'proficiency', _('Proficiency')

    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='activities')
    title = models.CharField(max_length=200)
    description = models.TextField(blank=True)
    category = models.CharField(max_length=50, choices=Category.choices, default=Category.CUSTOM)
    difficulty = models.CharField(max_length=50, choices=Difficulty.choices, default=Difficulty.MEDIUM)
    target_stat = models.CharField(max_length=50, choices=StatTarget.choices, default=StatTarget.KNOWLEDGE)
    estimated_time = models.PositiveIntegerField(help_text="Time in minutes", default=30)
    xp_reward = models.PositiveIntegerField(default=10)
    coin_reward = models.PositiveIntegerField(default=5)
    stat_reward = models.PositiveIntegerField(default=2)
    deadline = models.DateTimeField(null=True, blank=True)
    is_recurring = models.BooleanField(default=False)
    is_completed = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return self.title

class Skill(models.Model):
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='skills')
    name = models.CharField(max_length=100)
    current_percentage = models.PositiveIntegerField(default=0)
    target_percentage = models.PositiveIntegerField(default=100)
    hours_studied = models.FloatField(default=0.0)
    deadline = models.DateField(null=True, blank=True)
    
    def __str__(self):
        return self.name

class Achievement(models.Model):
    name = models.CharField(max_length=100)
    description = models.TextField()
    badge_icon = models.CharField(max_length=100, help_text="Icon identifier")

    def __str__(self):
        return self.name

class UserAchievement(models.Model):
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='achievements')
    achievement = models.ForeignKey(Achievement, on_delete=models.CASCADE)
    unlocked_at = models.DateTimeField(auto_now_add=True)

class JournalEntry(models.Model):
    class Mood(models.TextChoices):
        GREAT = 'great', _('Great')
        GOOD = 'good', _('Good')
        NEUTRAL = 'neutral', _('Neutral')
        BAD = 'bad', _('Bad')
        AWFUL = 'awful', _('Awful')

    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='journal_entries')
    date = models.DateField(auto_now_add=True)
    mood = models.CharField(max_length=20, choices=Mood.choices, default=Mood.NEUTRAL)
    reflection = models.TextField()
    gratitude = models.TextField(blank=True)
    ai_summary = models.TextField(blank=True, help_text="AI generated summary or motivation")

    def __str__(self):
        return f"{self.user.username} - {self.date}"

class DailyCheckIn(models.Model):
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='daily_checkins')
    date = models.DateField(auto_now_add=True)
    sleep = models.CharField(max_length=100)
    energy = models.PositiveIntegerField(default=5)
    mood = models.PositiveIntegerField(default=5)
    
    # Mission
    main_mission = models.CharField(max_length=255)
    definition_of_done = models.TextField()
    completed = models.BooleanField(default=False)
    
    # Insights
    wins = models.TextField(blank=True)
    avoidance = models.TextField(blank=True)
    distractions = models.TextField(blank=True)
    
    # Daydreaming details
    daydreaming_occurred = models.BooleanField(default=False)
    daydreaming_trigger = models.CharField(max_length=255, blank=True)
    daydreaming_duration = models.CharField(max_length=100, blank=True)
    daydreaming_preceded_by = models.TextField(blank=True)
    daydreaming_interrupted_by = models.TextField(blank=True)
    
    # XP Gained (Execute OS stats)
    xp_body = models.PositiveIntegerField(default=0)
    xp_knowledge = models.PositiveIntegerField(default=0)
    xp_communication = models.PositiveIntegerField(default=0)
    xp_discipline = models.PositiveIntegerField(default=0)
    xp_reflection = models.PositiveIntegerField(default=0)
    
    # Reflection / Next planning
    starting_easy = models.TextField(blank=True)
    starting_difficult = models.TextField(blank=True)
    tomorrow_mission = models.CharField(max_length=255, blank=True)
    tomorrow_action = models.CharField(max_length=255, blank=True)
    reward = models.CharField(max_length=255, blank=True)
    
    # Coach Output
    coach_score = models.CharField(max_length=50, default='Bronze')
    coach_response = models.TextField(blank=True)
    reflection_answer = models.TextField(blank=True)
    
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return f"{self.user.username} Check-in - {self.date} ({self.coach_score})"

