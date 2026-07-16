from rest_framework import viewsets, permissions, status
from rest_framework.response import Response
from rest_framework.decorators import action
from rest_framework.views import APIView
from django.contrib.auth import get_user_model
from .models import Profile, Activity, Skill, Achievement, UserAchievement, JournalEntry, DailyCheckIn
from .serializers import (
    UserSerializer, ProfileSerializer, ActivitySerializer,
    SkillSerializer, AchievementSerializer, UserAchievementSerializer,
    JournalEntrySerializer, DailyCheckInSerializer
)
from .gemini_coach import get_daily_coach_review, get_weekly_coach_review, parse_xp_awards


User = get_user_model()

class RegisterView(APIView):
    permission_classes = [permissions.AllowAny]

    def post(self, request):
        serializer = UserSerializer(data=request.data)
        if serializer.is_valid():
            serializer.save()
            return Response(serializer.data, status=status.HTTP_201_CREATED)
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

import csv
from rest_framework.parsers import MultiPartParser, FormParser

class UserProfileView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        serializer = UserSerializer(request.user)
        return Response(serializer.data)

class ImportCSVView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    parser_classes = (MultiPartParser, FormParser)

    def post(self, request):
        file = request.FILES.get('file')
        if not file:
            return Response({'error': 'No file uploaded'}, status=status.HTTP_400_BAD_REQUEST)
        
        try:
            decoded_file = file.read().decode('utf-8').splitlines()
            reader = csv.reader(decoded_file)
            
            # Count rows, skipping header if present
            rows = list(reader)
            count = len(rows)
            # Assuming first row might be header
            if count > 0 and 'habit' in str(rows[0]).lower():
                count -= 1
                
            if count <= 0:
                return Response({'error': 'No data found in CSV'}, status=status.HTTP_400_BAD_REQUEST)
                
            # Grant 10 XP per imported habit
            profile = request.user.profile
            xp_gained = count * 10
            profile.xp += xp_gained
            
            # Level up logic
            new_level = (profile.xp // 100) + 1
            if new_level > profile.level:
                profile.level = new_level
                
            profile.save()
            
            return Response({'imported_count': count, 'new_xp': profile.xp, 'level': profile.level, 'xp_gained': xp_gained})
            
        except Exception as e:
            return Response({'error': str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)

class WebhookView(APIView):
    permission_classes = [permissions.AllowAny]

    def post(self, request):
        token = request.data.get('token')
        if not token:
            return Response({'error': 'No token provided'}, status=status.HTTP_400_BAD_REQUEST)
        
        try:
            profile = Profile.objects.get(webhook_token=token)
        except Profile.DoesNotExist:
            return Response({'error': 'Invalid token'}, status=status.HTTP_403_FORBIDDEN)
            
        # Parse habit data from !Habits/Shortcuts
        # E.g. {"token": "...", "habit_name": "Read", "reward_xp": 10}
        xp = int(request.data.get('reward_xp', 10))
        
        profile.xp += xp
        # Level up logic
        new_level = (profile.xp // 100) + 1
        if new_level > profile.level:
            profile.level = new_level
            
        profile.save()
        return Response({'status': 'success', 'new_xp': profile.xp, 'level': profile.level})

class ActivityViewSet(viewsets.ModelViewSet):
    serializer_class = ActivitySerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        return Activity.objects.filter(user=self.request.user)

    def perform_create(self, serializer):
        serializer.save(user=self.request.user)
        
    @action(detail=True, methods=['post'])
    def complete(self, request, pk=None):
        activity = self.get_object()
        if not activity.is_completed:
            activity.is_completed = True
            activity.save()
            
            # Update Profile Stats
            profile = request.user.profile
            profile.xp += activity.xp_reward
            profile.coins += activity.coin_reward
            
            # Determine stat increase
            stat = activity.target_stat
            current_stat_val = getattr(profile, stat, 0)
            setattr(profile, stat, current_stat_val + activity.stat_reward)
            
            # Simple level up logic
            # e.g., level = xp // 100 + 1
            new_level = (profile.xp // 100) + 1
            if new_level > profile.level:
                profile.level = new_level
                
            profile.save()
            return Response({'status': 'Activity completed, stats updated!'})
        return Response({'status': 'Activity already completed'}, status=status.HTTP_400_BAD_REQUEST)

class SkillViewSet(viewsets.ModelViewSet):
    serializer_class = SkillSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        return Skill.objects.filter(user=self.request.user)

    def perform_create(self, serializer):
        serializer.save(user=self.request.user)

class JournalEntryViewSet(viewsets.ModelViewSet):
    serializer_class = JournalEntrySerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        return JournalEntry.objects.filter(user=self.request.user)

    def perform_create(self, serializer):
        serializer.save(user=self.request.user)

class DailyCheckInViewSet(viewsets.ModelViewSet):
    serializer_class = DailyCheckInSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        return DailyCheckIn.objects.filter(user=self.request.user).order_by('-date', '-created_at')

    def perform_create(self, serializer):
        pass

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        
        log_data = serializer.validated_data
        
        # Get coach response
        score, coach_text = get_daily_coach_review(log_data)
        
        # Parse XP awards automatically from Gemini review
        xp_awards = parse_xp_awards(coach_text)
        
        # Save check-in with the parsed XP awards
        checkin = serializer.save(
            user=request.user,
            coach_score=score,
            coach_response=coach_text,
            xp_body=xp_awards.get('Body', 0),
            xp_knowledge=xp_awards.get('Knowledge', 0),
            xp_communication=xp_awards.get('Communication', 0),
            xp_discipline=xp_awards.get('Discipline', 0),
            xp_reflection=xp_awards.get('Reflection', 0)
        )
        
        # Update user profile stats
        profile = request.user.profile
        
        profile.guts += checkin.xp_body
        profile.knowledge += checkin.xp_knowledge
        profile.charm += checkin.xp_communication
        profile.proficiency += checkin.xp_discipline
        profile.kindness += checkin.xp_reflection
        
        xp_gained = (
            checkin.xp_body + 
            checkin.xp_knowledge + 
            checkin.xp_communication + 
            checkin.xp_discipline + 
            checkin.xp_reflection
        )
        profile.xp += xp_gained
        
        new_level = (profile.xp // 100) + 1
        if new_level > profile.level:
            profile.level = new_level
            
        # Streak logic
        if checkin.completed:
            from datetime import timedelta, date as dt_date
            yesterday = dt_date.today() - timedelta(days=1)
            had_yesterday_completion = DailyCheckIn.objects.filter(
                user=request.user, 
                date=yesterday, 
                completed=True
            ).exists()
            
            if had_yesterday_completion or profile.current_streak == 0:
                profile.current_streak += 1
        else:
            profile.current_streak = 0
            
        profile.save()
        
        response_serializer = self.get_serializer(checkin)
        return Response(response_serializer.data, status=status.HTTP_201_CREATED)

    @action(detail=False, methods=['get'], url_path='weekly-review')
    def weekly_review(self, request):
        from datetime import timedelta, date as dt_date
        seven_days_ago = dt_date.today() - timedelta(days=7)
        logs = DailyCheckIn.objects.filter(user=request.user, date__gte=seven_days_ago).order_by('date')
        
        logs_list = []
        for log in logs:
            logs_list.append({
                'date': str(log.date),
                'main_mission': log.main_mission,
                'completed': log.completed,
                'coach_score': log.coach_score,
                'avoidance': log.avoidance,
                'distractions': log.distractions,
                'daydreaming_occurred': log.daydreaming_occurred,
                'daydreaming_trigger': log.daydreaming_trigger,
                'daydreaming_duration': log.daydreaming_duration,
                'starting_easy': log.starting_easy,
                'starting_difficult': log.starting_difficult,
            })
            
        if not logs_list:
            return Response(
                {'review': "No check-in logs found for the past week. Please complete at least one check-in to generate a review."},
                status=status.HTTP_400_BAD_REQUEST
            )
            
        is_deep = request.query_params.get('deep') == 'true'
        review_text = get_weekly_coach_review(logs_list, is_deep=is_deep)
        return Response({'review': review_text})

