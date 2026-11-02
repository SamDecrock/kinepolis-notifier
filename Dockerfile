# node:20 on Debian: cycletls ships a Go binary that needs glibc, so no alpine.
FROM node:20

# rsvg-convert renders the seat map to PNG for the Pushover attachment.
RUN apt-get update && apt-get install -y --no-install-recommends librsvg2-bin fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# state.json and layouts.json live on the /data volume; the log goes to stdout.
ENV STATE_DIR=/data LOG_FILE=0
RUN mkdir -p /data

CMD [ "node", "notifier.js", "--loop" ]
