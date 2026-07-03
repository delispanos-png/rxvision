# syntax=docker/dockerfile:1
# Base image pinned by DIGEST (H-5): the floating `3.12-slim` tag moves silently on every rebuild
# (supply-chain drift). Bump this digest deliberately when you intend to update the base.
FROM python:3.12-slim@sha256:423ed6ab25b1921a477529254bfeeabf5855151dc2c3141699a1bfc852199fbf AS base
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1
WORKDIR /app

FROM base AS deps
# requirements.lock (H-5) pins every transitive dependency to a known-good version (generated via
# `pip freeze` from a verified image), so a rebuild can't pull a newer/compromised upstream release.
COPY pyproject.toml requirements.lock ./
RUN pip install --upgrade pip && pip install -e . -c requirements.lock

FROM base AS runtime
# OCR runtime: Tesseract (+Greek) and zbar for the optical-audit pipeline
RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr tesseract-ocr-ell libzbar0 \
    && rm -rf /var/lib/apt/lists/*
# non-root
RUN useradd -m -u 10001 appuser
COPY --from=deps /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=deps /usr/local/bin /usr/local/bin
COPY . .
USER appuser
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
