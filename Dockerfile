# Dockerfile for Northflank.
#
# Build option in Northflank MUST be set to "Dockerfile" (not Buildpack).
# This pins the port so the platform's routed port and the app's listening
# port always match — a mismatch is what produces "Not found" on every path.

FROM node:20-alpine

WORKDIR /usr/src/app

# App listens on process.env.PORT; we fix it to 3000 and EXPOSE the same port
# so Northflank auto-detects and routes to it.
ENV PORT=3000

# Persistent-volume mount point for the file-backed 24h tally + busiest-day
# record. (Incident history goes to PostgreSQL via DATABASE_URL, set as a
# Northflank secret/env var — see DEPLOY.md.)
ENV STATE_DIR=/data
RUN mkdir -p /data

# Install dependencies. Copy only package.json first for layer caching, then
# install. We verify 'pg' actually landed so a broken/cached install fails the
# BUILD loudly instead of silently shipping an image that can't archive.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund \
 && node -e "require('pg'); console.log('pg installed OK')"

COPY server.js ./
COPY db.js ./
COPY public ./public

EXPOSE 3000

CMD ["node", "server.js"]
