# Сервис скачивания для «Музыки» Parvane (spec 039, этап B). Необязательный: включается профилем compose
# `music-fetch`. yt-dlp часто обновляется вслед за источниками — версию поднимать пересборкой образа.
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir "yt-dlp>=2026.1"
COPY server.py sites.py catalog.py /app/
USER 1000:1000
EXPOSE 9350
CMD ["python3", "/app/server.py"]
