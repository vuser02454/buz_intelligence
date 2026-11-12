# ==============================================================================
# Makefile for Crowd Heatmap & Business Intelligence Platform
# ==============================================================================

.PHONY: dev run start setup migrate test train superuser check clean help

PYTHON ?= $(shell if [ -f .venv/bin/python ]; then echo .venv/bin/python; elif [ -f venv/bin/python ]; then echo venv/bin/python; else echo python3; fi)
PORT ?= 8000
HOST ?= 127.0.0.1

help: ## Show this help message
	@echo "Available commands:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

dev: ## Start full-stack development server (Frontend + Backend + WebSockets)
	@$(PYTHON) run.py dev --host $(HOST) --port $(PORT)

run: dev ## Alias for dev

start: dev ## Alias for dev

setup: ## Set up virtual environment, install requirements, and run migrations
	@$(PYTHON) run.py setup

migrate: ## Apply database migrations
	@$(PYTHON) run.py migrate

test: ## Run unit and integration tests
	@$(PYTHON) run.py test

train: ## Train or retrain Scikit-Learn recommendation model
	@$(PYTHON) run.py train

superuser: ## Create Django admin superuser
	@$(PYTHON) run.py superuser

check: ## Run Django system configuration checks
	@$(PYTHON) run.py check

clean: ## Clean up Python bytecode and cache files
	@$(PYTHON) run.py clean
