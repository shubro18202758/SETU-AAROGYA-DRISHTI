FROM python:3.13-alpine

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY workers/enrichment/pyproject.toml ./
RUN pip install --upgrade pip && pip install .

COPY workers/enrichment/app ./app
COPY backend ./backend

CMD ["python", "-m", "app.main"]
