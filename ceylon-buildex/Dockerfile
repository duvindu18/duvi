# Alternative to run.sh (and to CeylonBuildex.exe on Windows): everything (Python, Poppler, Tesseract incl. Sinhala + Tamil) inside one container.
#   docker compose up --build        then open http://127.0.0.1:8080
FROM python:3.12-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends poppler-utils tesseract-ocr tesseract-ocr-sin tesseract-ocr-tam \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
ENV HOST=0.0.0.0 PORT=8080 OCR_LANGS=eng+sin+tam UPDATE_ON_START=first
EXPOSE 8080
CMD ["sh", "-c", "python -m app.ingest init && python -m app.server"]
