FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends docker.io ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && mkdir -p /app/data && chown node:node /app/data
COPY app.js start.js ./
COPY lib ./lib
USER node
ENV NODE_ENV=production HOST=0.0.0.0
EXPOSE 3000
CMD ["node", "start.js"]
