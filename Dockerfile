# -------------------------------------------------
# Dockerfile – builds a container that runs Daphne (ASGI)
# -------------------------------------------------
FROM python:3.12-slim

# System libs needed for psycopg2 (PostgreSQL driver)
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc libpq-dev && rm -rf /var/lib/apt/lists/*

# Working directory inside the container
WORKDIR /app

# Copy the whole project into the image
COPY . /app

# Install Python dependencies
RUN pip install --upgrade pip && \
    pip install -r requirements.txt

# Collect static files (required for Django)
ENV DJANGO_SETTINGS_MODULE=crowd_heatmap_project.settings
RUN python manage.py collectstatic --noinput

# Render will set the $PORT env var; expose it
EXPOSE $PORT

# Start Daphne (ASGI server) – this is what Render will run
CMD ["daphne", "-b", "0.0.0.0", "-p", "$PORT", "crowd_heatmap_project.asgi:application"]
