# Spike 1: can the NDA engine render a PDF inside a container on arm64 (same architecture as the production host)?
FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip python3-venv libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz-subset0 fonts-dejavu-core \
 && python3 -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir "weasyprint==62.3" \
 && rm -rf /var/lib/apt/lists/*
ENV PATH="/opt/venv/bin:$PATH"
RUN useradd -m engine
USER engine
WORKDIR /skill
