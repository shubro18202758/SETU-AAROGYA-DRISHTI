FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY workers/signals/pyproject.toml ./
RUN pip install --upgrade pip && pip install .

COPY workers/signals/app ./app
COPY backend ./backend

CMD ["python", "-m", "app.main"]
