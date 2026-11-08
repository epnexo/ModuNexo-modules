# Build from the module folder:  docker build -f engine/Dockerfile -t documents-engine .
FROM python:3.12-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz0b fonts-dejavu-core fonts-liberation \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY render/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY render/render.py ./render.py
COPY engine/server.py ./server.py
RUN useradd --system --uid 10001 engine
USER engine
ENV ENGINE_PORT=8080
EXPOSE 8080
HEALTHCHECK CMD python -c "import urllib.request,os;urllib.request.urlopen('http://127.0.0.1:%s/health'%os.environ.get('ENGINE_PORT','8080'))"
CMD ["python", "server.py"]
