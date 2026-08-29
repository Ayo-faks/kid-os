FROM python:3.12-slim@sha256:229a2c5bfa27522db7815ea81f9bed70af17ccb9de9fc7ad142b1877b5830d36

ENV HERMES_CONFIG=/app/config.yaml \
    HERMES_HOST=0.0.0.0 \
    HERMES_PORT=8080 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY pyproject.toml ./pyproject.toml
COPY requirements-lock.txt ./requirements-lock.txt
COPY careos_agent ./careos_agent
COPY config.yaml ./config.yaml
COPY skills ./skills

RUN pip install --no-cache-dir --require-hashes -r requirements-lock.txt

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD python -c "from urllib.request import urlopen; urlopen('http://127.0.0.1:8080/health', timeout=2).read()"

CMD ["python", "-m", "careos_agent.server"]