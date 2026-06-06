FROM python:3.12-slim

WORKDIR /app

# Install system deps (git for agent terminal, jq, curl)
RUN apt-get update -qq && \
    apt-get install -y -qq git curl jq tmux > /dev/null 2>&1 && \
    rm -rf /var/lib/apt/lists/*

# Install uv (fast Python package manager)
RUN pip install uv -q

# Pre-install OpenHands SDK (baked into image — no install at runtime)
RUN uv pip install --system openhands openhands-tools fastapi uvicorn[standard]

# Copy app
COPY app.py ./app.py

EXPOSE 8080

# Run SDK service
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080"]
