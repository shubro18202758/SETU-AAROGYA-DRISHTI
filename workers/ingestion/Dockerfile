FROM mcr.microsoft.com/playwright/python:v1.56.0-noble

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY workers/ingestion/pyproject.toml ./
RUN pip install --upgrade pip && pip install . && crawl4ai-setup

COPY workers/ingestion/app ./app
COPY backend ./backend

CMD ["python", "-m", "app.main"]
