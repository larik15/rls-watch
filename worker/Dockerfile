FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY worker ./worker
COPY shared ./shared

# Env comes from docker-compose's env_file (.env), not baked into the image.
CMD ["node", "worker/index.mjs"]
