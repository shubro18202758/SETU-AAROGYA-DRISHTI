FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/models \
    TRANSFORMERS_CACHE=/models

WORKDIR /app

# OS deps for sentencepiece / tokenizers wheels.
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY workers/normalizer/pyproject.toml ./
RUN pip install --upgrade pip && pip install ".[indic]"

COPY workers/normalizer/app ./app
COPY backend ./backend

CMD ["python", "-m", "app.main"]
