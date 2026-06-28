# Dockerfile for Northflank.
#
# Build option in Northflank MUST be set to "Dockerfile" (not Buildpack).
# This pins the port so the platform's routed port and the app's listening
# port always match — a mismatch is what produces "Not found" on every path.
#
# The app has no npm dependencies, so there is no install step.

FROM node:20-alpine

WORKDIR /usr/src/app

# App listens on process.env.PORT; we fix it to 3000 and EXPOSE the same port
# so Northflank auto-detects and routes to it.
ENV PORT=3000

# Persistent-volume mount point. Mount a Northflank volume here so the rolling
# 24h tally survives redeploys. Without a volume the app still runs; the count
# just resets on each redeploy.
ENV STATE_DIR=/data
RUN mkdir -p /data

COPY package.json ./
COPY server.js ./

EXPOSE 3000

CMD ["node", "server.js"]
