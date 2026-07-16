import os
import re
import requests
import google.generativeai as genai
from dotenv import load_dotenv

# Path to .env is parent's parent of this file
_BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_ENV_PATH = os.path.join(_BASE_DIR, '.env')
load_dotenv(dotenv_path=_ENV_PATH, override=True)

# ----------------- SYSTEM INSTRUCTIONS -----------------

GEMINI_CALCULATION_INSTRUCTION = """
You are the user's gamified performance calculator. Analyze the daily check-in log and determine:
- Daily Score: Bronze, Silver, Gold, or Diamond.
  - Diamond: Completed Main Mission with zero/minimal distraction, high focus.
  - Gold: Completed mission but had some distractions/daydreaming.
  - Silver: Mission partially completed, or checked in but major avoidance/distractions.
  - Bronze: Mission not completed at all, or complete avoidance of responsibility.
  
- XP Awards: Award 0 to 10 points for:
  - Discipline (10 if Main Mission completed, deduct 3-5 for distractions/daydreaming)
  - Knowledge (up to 10 if they studied, read, wrote code, built projects, or did creative learning)
  - Body (up to 10 based on sleep quality, energy, and physical health/gym logged)
  - Communication (up to 10 for team meetings, presentations, collaborations, or social wins)
  - Reflection (up to 10 based on how detailed their wins, avoidance, starting ease/difficulty, and check-in inputs are)
   
You MUST output exactly in this format (no other text, just these two lines):
SCORE: [Bronze / Silver / Gold / Diamond]
XP_AWARD: Body=[0-10], Knowledge=[0-10], Communication=[0-10], Discipline=[0-10], Reflection=[0-10]
"""

GROQ_COACH_INSTRUCTION = """
You are the user's Executive Function Coach, Accountability Partner, Behavioral Analyst, and Performance Reviewer.
Your purpose is to reduce the gap between what they intend to do and what they actually execute.
Always prioritize execution over planning.
Challenge their assumptions and rationalizations respectfully.
Do not let them escape into productivity systems, planning, research, or optimization.

MISSION RULES:
Every mission must satisfy:
- Can be completed today.
- Produces a visible outcome.
- Has a first action that takes less than two minutes.
- Is concrete.

RESPONSE FORMAT:
Generate a detailed daily review. You MUST structure it into these sections:

### Mission Review
Did the user execute today's mission? If not, identify the real reason.

### Pattern Detection
Identify recurring behaviors. Do not repeat previous observations unless they continue to appear.

### Challenge My Thinking
If they rationalize, procrastinate, or make excuses, respectfully challenge their reasoning. Help distinguish between genuine obstacles and avoidance.

### ONE Improvement
Give exactly ONE improvement for tomorrow. Never overwhelm with long lists.

### Tomorrow
Tomorrow's ONE Main Mission
Tomorrow's first two-minute action
Reward after completion

### Reflection Question
Finish with ONE thoughtful question that helps the user better understand their behavior and patterns over time.
"""

GROQ_WEEKLY_INSTRUCTION = """
You are the user's Executive Function Coach, Accountability Partner, and Performance Reviewer.
Analyze their behavior over the past week and write a raw, direct, and hard-hitting Weekly Diagnostics Review.

TONE:
- Do NOT sound like an academic textbook, a dry reporter, or a gentle therapist.
- Speak directly, concisely, and with intense execution-focused urgency.
- Avoid explaining basic definitions (do NOT define terms like "hyperfocus" or "avoidance" - the user already knows what they mean).
- Call out excuses, rationalizations, and passive "planning-as-avoidance" patterns directly.
- Use sharp, punchy, active phrasing.

STRUCTURE:
Output exactly these sections using markdown headers:

### 1. Distraction Triggers
Name the exact culprits. Call out vague inputs like "some thing" as avoidance of tracking.

### 2. Avoidance Patterns
What specific tasks did they duck? Call out the excuses (like "tired from travel") and dissect whether it was a real blocker or just avoidance.

### 3. Hyperfocus Events
Where did they actually lock in? If none occurred, state it bluntly: "Zero focus lock-in. You operated on passive autopilot."

### 4. Routines That Worked
What actually moved the needle? If they tried a tool (like Pomodoro) but failed to complete the task, do not call it a success.

### 5. Routines That Failed
What habits, presets, or excuses consistently wrecked their execution this week?

### 6. Execution Summary
Provide a blunt verdict: Did they actually execute and build momentum, or did they just play around with productivity setups and plan more than they executed?

### 7. Core Directives For Next Week
Provide exactly THREE direct, actionable rules for next week to force execution. No fluff.
"""

# ----------------- APIS CONNECTORS -----------------

def get_gemini_model(system_instruction):
    load_dotenv(dotenv_path=_ENV_PATH, override=True)
    api_key = os.getenv("GEMINI_API_KEY")
    model_name = os.getenv("GEMINI_MODEL_NAME", "models/gemini-2.5-flash")
    
    if not api_key:
        raise ValueError("GEMINI_API_KEY not found in .env file.")
        
    genai.configure(api_key=api_key)
    model = genai.GenerativeModel(
        model_name=model_name,
        system_instruction=system_instruction
    )
    return model

def get_groq_completion(system_instruction, prompt):
    load_dotenv(dotenv_path=_ENV_PATH, override=True)
    api_key = os.getenv("GROQ_API_KEY")
    model_name = os.getenv("GROQ_MODEL_NAME", "llama-3.3-70b-versatile")
    
    if not api_key:
        raise ValueError("GROQ_API_KEY not found in .env file.")
        
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }
    
    payload = {
        "model": model_name,
        "messages": [
            {"role": "system", "content": system_instruction},
            {"role": "user", "content": prompt}
        ],
        "temperature": 0.7
    }
    
    url = "https://api.groq.com/openai/v1/chat/completions"
    response = requests.post(url, json=payload, headers=headers)
    response.raise_for_status()
    return response.json()['choices'][0]['message']['content']

# ----------------- PARSERS -----------------

def parse_score(coach_text):
    match = re.search(r'SCORE:\s*(Diamond|Gold|Silver|Bronze)', coach_text, re.IGNORECASE)
    if match:
        return match.group(1).capitalize()
    return 'Bronze'

def parse_xp_text(text):
    match = re.search(r'(XP_AWARD:\s*Body=\d+,\s*Knowledge=\d+,\s*Communication=\d+,\s*Discipline=\d+,\s*Reflection=\d+)', text, re.IGNORECASE)
    if match:
        return match.group(1)
    return "XP_AWARD: Body=0, Knowledge=0, Communication=0, Discipline=0, Reflection=0"

def parse_xp_awards(coach_text):
    xp = {'Body': 0, 'Knowledge': 0, 'Communication': 0, 'Discipline': 0, 'Reflection': 0}
    match = re.search(r'XP_AWARD:\s*Body=(\d+),\s*Knowledge=(\d+),\s*Communication=(\d+),\s*Discipline=(\d+),\s*Reflection=(\d+)', coach_text, re.IGNORECASE)
    if match:
        xp['Body'] = int(match.group(1))
        xp['Knowledge'] = int(match.group(2))
        xp['Communication'] = int(match.group(3))
        xp['Discipline'] = int(match.group(4))
        xp['Reflection'] = int(match.group(5))
    return xp

# ----------------- COACH HANDLERS -----------------

def get_daily_coach_review(log_data):
    """
    Split execution:
    1. Gemini calculates Score and XP points.
    2. Groq generates the qualitative behavioral feedback text.
    """
    prompt = f"""
Daily Log Data:
Sleep: {log_data.get('sleep', 'N/A')}
Energy (1–10): {log_data.get('energy', 'N/A')}
Mood (1–10): {log_data.get('mood', 'N/A')}

Today’s Main Mission: {log_data.get('main_mission', 'N/A')}
Definition of Done: {log_data.get('definition_of_done', 'N/A')}
Completed? {'Yes' if log_data.get('completed') else 'No'}

Today’s Wins: {log_data.get('wins', '')}
Today’s Avoidance: {log_data.get('avoidance', '')}
Distractions: {log_data.get('distractions', '')}

Did daydreaming occur? {'Yes' if log_data.get('daydreaming_occurred') else 'No'}
Trigger: {log_data.get('daydreaming_trigger', '')}
Duration: {log_data.get('daydreaming_duration', '')}
What happened immediately before: {log_data.get('daydreaming_preceded_by', '')}
What interrupted it: {log_data.get('daydreaming_interrupted_by', '')}

What made starting easy: {log_data.get('starting_easy', '')}
What made starting difficult: {log_data.get('starting_difficult', '')}

Tomorrow’s Main Mission: {log_data.get('tomorrow_mission', '')}
Tomorrow’s first action (<2 minutes): {log_data.get('tomorrow_action', '')}
Reward after completion: {log_data.get('reward', '')}
"""

    # 1. Fetch score & XP calculations from Gemini
    try:
        model = get_gemini_model(GEMINI_CALCULATION_INSTRUCTION)
        gemini_res = model.generate_content(prompt)
        gemini_text = gemini_res.text if (gemini_res and gemini_res.text) else ""
    except Exception as e:
        gemini_text = f"SCORE: Bronze\nXP_AWARD: Body=0, Knowledge=0, Communication=0, Discipline=0, Reflection=0\n(Gemini calculation error: {str(e)})"

    score = parse_score(gemini_text)
    xp_text = parse_xp_text(gemini_text)

    # 2. Fetch qualitative coach feedback text from Groq
    try:
        groq_text = get_groq_completion(GROQ_COACH_INSTRUCTION, prompt)
    except Exception as e:
        groq_text = f"### Mission Review\nFailed to generate coach feedback. (Groq API error: {str(e)})"

    # 3. Combine into the unified format expected by the frontend
    combined_response = f"SCORE: {score}\n{xp_text}\n\n{groq_text}"
    return score, combined_response

def get_weekly_coach_review(logs_list):
    """
    Generates a weekly review utilizing the fast Groq completion.
    """
    if not logs_list:
        return "No logs found for the past week to perform analysis."
        
    logs_summary = []
    for idx, log in enumerate(logs_list):
        summary = f"""
Day {idx+1} ({log.get('date')}):
- Mission: {log.get('main_mission')} (Completed: {log.get('completed')})
- Score: {log.get('coach_score')}
- Avoidance: {log.get('avoidance')}
- Distractions: {log.get('distractions')}
- Daydreaming Trigger/Duration: {log.get('daydreaming_trigger') if log.get('daydreaming_occurred') else 'None'} / {log.get('daydreaming_duration')}
- Starting ease/difficulty: {log.get('starting_easy')} / {log.get('starting_difficult')}
"""
        logs_summary.append(summary)
        
    prompt = f"""
Here are my check-in logs for the past week:
{"="*30}
{"".join(logs_summary)}
{"="*30}

Please analyze these logs and generate my Weekly Behavioral Diagnostics Review.
"""

    try:
        review_text = get_groq_completion(GROQ_WEEKLY_INSTRUCTION, prompt)
        return review_text
    except Exception as e:
        return f"Coaching System Error (Groq API): {str(e)}"
