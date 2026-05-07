FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY workers/writer/pyproject.toml ./
RUN pip install --upgrade pip && pip install .

COPY workers/writer/app ./app
COPY backend ./backend

CMD ["python", "-m", "app.main"]
