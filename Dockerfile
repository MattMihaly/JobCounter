# Dockerfile for Northflank (and any container host).
#
# This app has NO npm dependencies — it's plain Node core modules — so there's
# no `npm install` step. We pin the port explicitly so Northflank's exposed
# public port always matches the port the app listens on. This is the single
# most common reason a "working locally" Node app fails to deploy: a port
# mismatch between the platform's routing and the app's listener.

FROM node:20-alpine

WORKDIR /usr/src/app

# The app reads process.env.PORT; we fix it to 3000 and expose the same port
# so Northflank detects and routes to it automatically.
ENV PORT=3000

# STATE_DIR points at the persistent volume you mount in Northflank (see README).
# Defaults to a path we also create below; mount a volume here to survive
# redeploys, otherwise the 24h tally resets on each deploy.
ENV STATE_DIR=/data
RUN mkdir -p /data

# Copy application source (server.js, public/, package.json).
COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
