# How to Execute the Crowd Heatmap & Business Intelligence Project

This project includes a unified terminal runner that starts both the frontend and backend with a single command.

---

## Quick Start (One Command)

Choose your preferred environment:

### macOS / Linux
```bash
./run.sh
```

### Python CLI (Cross-Platform)
```bash
python3 run.py
```

### Make
```bash
make run
```

### npm / Node.js
```bash
npm run dev
```

### Windows (PowerShell / Command Prompt)
```powershell
# In PowerShell:
.\run.ps1

# In Command Prompt:
run.bat
```

Once started, open your browser at:
- **Frontend Dashboard:** [http://127.0.0.1:8000/](http://127.0.0.1:8000/)
- **Business Intelligence Analytics:** [http://127.0.0.1:8000/dashboard/](http://127.0.0.1:8000/dashboard/)
- **Admin Panel:** [http://127.0.0.1:8000/admin/](http://127.0.0.1:8000/admin/)
- **WebSocket AI Chatbot:** `ws://127.0.0.1:8000/ws/chat/`

---

## All CLI Commands

| Action | Bash Script | Python CLI | Make | npm |
| :--- | :--- | :--- | :--- | :--- |
| **Start Server** | `./run.sh` | `python3 run.py` | `make dev` | `npm run dev` |
| **Custom Port** | `./run.sh --port 8080` | `python3 run.py --port 8080` | `make dev PORT=8080` | — |
| **First-Time Setup** | `./run.sh setup` | `python3 run.py setup` | `make setup` | `npm run setup` |
| **Run Migrations** | `./run.sh migrate` | `python3 run.py migrate` | `make migrate` | `npm run migrate` |
| **Run Tests** | `./run.sh test` | `python3 run.py test` | `make test` | `npm test` |
| **Train ML Model** | `./run.sh train` | `python3 run.py train` | `make train` | `npm run train` |
| **Create Superuser** | `./run.sh superuser` | `python3 run.py superuser` | `make superuser` | `npm run superuser` |
| **System Check** | `./run.sh check` | `python3 run.py check` | `make check` | `npm run check` |
| **Clean Cache** | `./run.sh clean` | `python3 run.py clean` | `make clean` | `npm run clean` |
| **Help Menu** | `./run.sh help` | `python3 run.py --help` | `make help` | — |

---

## Manual Step-by-Step Setup

If you prefer to run the raw underlying commands:

### 1. Create and Activate Virtual Environment
```bash
# macOS/Linux
python3 -m venv .venv
source .venv/bin/activate

# Windows PowerShell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```

### 2. Install Dependencies
```bash
pip install -r requirements.txt
```

### 3. Run Database Migrations
```bash
python manage.py migrate
```

### 4. Start ASGI Daphne Server
```bash
python manage.py runserver
```

---

## Troubleshooting

### Port Already in Use
If port 8000 is occupied, use a different port:
```bash
./run.sh --port 8080
# or
python3 run.py --port 8080
```

### Missing Module Errors
Ensure your virtual environment is active or run:
```bash
./run.sh setup
# or
python3 run.py setup
```

### Stopping the Server
Press `CTRL + C` in your terminal to safely stop the server.
