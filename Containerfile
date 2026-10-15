# 3D Lab: the web UI and the Python service in one image.
#
#   podman build -t 3d-lab .   (docker: docker build -f Containerfile -t 3d-lab .)
#   podman run -d -p 8080:8080 -e VIEWER_API_TOKEN=... \
#     -v ./config:/config:ro,Z -v lab3d-data:/data:Z 3d-lab
#
# /config holds config.yaml (optional), redfish_servers.yaml, redfish_secrets.yaml and wiring files;
# /data is the topology store (index, latest topology, history, remembered ad-hoc hosts).

FROM docker.io/library/node:22-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm test && npm run build

FROM docker.io/library/python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app
COPY pyproject.toml README.md LICENSE ./
COPY lab3d/ lab3d/
RUN pip install --root-user-action=ignore . && useradd --uid 10001 --no-create-home --home-dir /data --shell /usr/sbin/nologin lab3d \
    && mkdir -p /config /data && chown lab3d /data
COPY --from=web /web/dist /app/web/dist
COPY web/src/layouts/models.json /app/web/models.json

# The service reads ./config.yaml when present, and the inventory files next to it by default.
WORKDIR /config
ENV VIEWER_DATA_DIR=/data \
    VIEWER_STATIC_DIR=/app/web/dist \
    VIEWER_LAYOUTS_FILE=/app/web/models.json \
    VIEWER_BIND=0.0.0.0 \
    VIEWER_PORT=8080

USER lab3d
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s --start-period=10s \
    CMD ["3d-lab", "healthcheck"]
ENTRYPOINT ["3d-lab"]
CMD ["serve"]
