#!/usr/bin/env bash
# ==============================================================================
# Crowd Heatmap & Business Intelligence Platform - Terminal Runner
# ==============================================================================
# Usage:
#   ./run.sh                  Start full-stack dev server (frontend + backend)
#   ./run.sh dev [--port N]   Start development server on specified port (default: 8000)
#   ./run.sh setup            Install venv, dependencies, migrations, ML model
#   ./run.sh migrate          Run database migrations
#   ./run.sh test             Run the test suite
#   ./run.sh train            Retrain the ML recommendation model
#   ./run.sh superuser        Create Django admin superuser
#   ./run.sh check            Run Django system check
#   ./run.sh help             Show this help menu
# ==============================================================================

set -e

# Colors
C_RESET='\033[0m'
C_BOLD='\033[1m'
C_CYAN='\033[0;36m'
C_GREEN='\033[0;32m'
C_YELLOW='\033[0;33m'
C_RED='\033[0;31m'
C_DIM='\033[2m'

# Resolve root directory of script
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

# Virtual environment python resolution
PYTHON_EXEC=""
if [ -f "$PROJECT_DIR/.venv/bin/python" ]; then
    PYTHON_EXEC="$PROJECT_DIR/.venv/bin/python"
elif [ -f "$PROJECT_DIR/venv/bin/python" ]; then
    PYTHON_EXEC="$PROJECT_DIR/venv/bin/python"
elif command -v python3 &>/dev/null; then
    PYTHON_EXEC="$(command -v python3)"
elif command -v python &>/dev/null; then
    PYTHON_EXEC="$(command -v python)"
else
    echo -e "${C_RED}[ERROR] Python 3.10+ is required but not found in PATH or .venv.${C_RESET}"
    exit 1
fi

# Export PYTHONPATH so all project apps are resolvable
export PYTHONPATH="$PROJECT_DIR:${PYTHONPATH:-}"

# Show banner
show_banner() {
    echo -e "${C_CYAN}${C_BOLD}"
    echo "======================================================================"
    echo "   CROWD HEATMAP & BUSINESS INTELLIGENCE PLATFORM (BI)"
    echo "======================================================================"
    echo -e "${C_RESET}  ${C_DIM}• Django 6.0+ | Daphne ASGI | WebSockets | Scikit-Learn | Leaflet${C_RESET}"
    echo ""
}

# Subcommands
COMMAND="${1:-dev}"
shift || true

case "$COMMAND" in
    dev|start|server|run)
        PORT="8000"
        HOST="127.0.0.1"
        while [[ "$#" -gt 0 ]]; do
            case "$1" in
                -p|--port) PORT="$2"; shift 2 ;;
                -h|--host) HOST="$2"; shift 2 ;;
                *) shift ;;
            esac
        done

        show_banner
        echo -e "${C_BOLD}Starting Frontend & Backend Server:${C_RESET}"
        echo -e "  ${C_GREEN}➜${C_RESET}  ${C_BOLD}Frontend Home:${C_RESET}     ${C_CYAN}http://${HOST}:${PORT}/${C_RESET}"
        echo -e "  ${C_GREEN}➜${C_RESET}  ${C_BOLD}BI Dashboard:${C_RESET}      ${C_CYAN}http://${HOST}:${PORT}/dashboard/${C_RESET}"
        echo -e "  ${C_GREEN}➜${C_RESET}  ${C_BOLD}Admin Panel:${C_RESET}       ${C_CYAN}http://${HOST}:${PORT}/admin/${C_RESET}"
        echo -e "  ${C_GREEN}➜${C_RESET}  ${C_BOLD}WebSocket Engine:${C_RESET}  ${C_DIM}ws://${HOST}:${PORT}/ws/chat/${C_RESET}"
        echo -e "  ${C_GREEN}➜${C_RESET}  ${C_BOLD}Server Core:${C_RESET}       ${C_DIM}Daphne ASGI (HTTP + WS)${C_RESET}"
        echo ""
        echo -e "${C_DIM}Press CTRL+C to stop the server.${C_RESET}"
        echo "----------------------------------------------------------------------"
        exec "$PYTHON_EXEC" manage.py runserver "${HOST}:${PORT}"
        ;;

    setup)
        show_banner
        echo -e "${C_BOLD}${C_CYAN}==> Setting up development environment...${C_RESET}"
        if [ ! -d ".venv" ]; then
            echo -e "${C_YELLOW}[1/4]${C_RESET} Creating virtual environment..."
            "$PYTHON_EXEC" -m venv .venv
            PYTHON_EXEC="$PROJECT_DIR/.venv/bin/python"
        else
            echo -e "${C_GREEN}[1/4]${C_RESET} Virtual environment exists at .venv"
        fi

        echo -e "${C_YELLOW}[2/4]${C_RESET} Installing dependencies..."
        "$PYTHON_EXEC" -m pip install -r requirements.txt

        echo -e "${C_YELLOW}[3/4]${C_RESET} Applying database migrations..."
        "$PYTHON_EXEC" manage.py migrate

        echo -e "${C_YELLOW}[4/4]${C_RESET} Checking/training ML model..."
        if [ ! -f "crowd_heatmap_project/business_model.pkl" ]; then
            "$PYTHON_EXEC" crowd_heatmap_project/train_model.py
        fi

        echo -e "\n${C_GREEN}${C_BOLD}✓ Setup successfully finished! Run ./run.sh to start.${C_RESET}"
        ;;

    migrate)
        show_banner
        echo -e "${C_BOLD}${C_CYAN}==> Applying migrations...${C_RESET}"
        "$PYTHON_EXEC" manage.py makemigrations
        "$PYTHON_EXEC" manage.py migrate
        ;;

    test)
        show_banner
        echo -e "${C_BOLD}${C_CYAN}==> Running test suite...${C_RESET}"
        exec "$PYTHON_EXEC" manage.py test "$@"
        ;;

    train)
        show_banner
        echo -e "${C_BOLD}${C_CYAN}==> Training recommendation model...${C_RESET}"
        exec "$PYTHON_EXEC" crowd_heatmap_project/train_model.py
        ;;

    superuser)
        show_banner
        echo -e "${C_BOLD}${C_CYAN}==> Creating Django admin superuser...${C_RESET}"
        exec "$PYTHON_EXEC" manage.py createsuperuser
        ;;

    check)
        show_banner
        echo -e "${C_BOLD}${C_CYAN}==> Running system checks...${C_RESET}"
        exec "$PYTHON_EXEC" manage.py check
        ;;

    clean)
        show_banner
        echo -e "${C_BOLD}${C_CYAN}==> Cleaning cache files...${C_RESET}"
        find . -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
        find . -type f -name "*.pyc" -delete 2>/dev/null || true
        echo -e "${C_GREEN}Cache cleaned.${C_RESET}"
        ;;

    help|--help|-h)
        show_banner
        echo "Available Commands:"
        echo "  ./run.sh                  Start full-stack dev server (frontend + backend)"
        echo "  ./run.sh dev [--port N]   Start dev server on custom port (e.g. --port 8080)"
        echo "  ./run.sh setup            Install dependencies, run migrations, verify ML model"
        echo "  ./run.sh migrate          Apply database migrations"
        echo "  ./run.sh test             Run all unit and integration tests"
        echo "  ./run.sh train            Train/retrain Scikit-Learn recommendation model"
        echo "  ./run.sh superuser        Create Django admin superuser"
        echo "  ./run.sh check            Run Django configuration check"
        echo "  ./run.sh clean            Remove Python bytecode cache"
        echo "  ./run.sh help             Show this help menu"
        ;;

    *)
        echo -e "${C_RED}Unknown command: $COMMAND${C_RESET}"
        echo "Run './run.sh help' to view available commands."
        exit 1
        ;;
esac
