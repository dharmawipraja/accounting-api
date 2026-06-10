# --- Build stage ---
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
# DATABASE_URL here is a dummy so prisma.config.ts resolves during `prisma generate`;
# generate never connects. The real URL is supplied at runtime via the environment.
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build?schema=public" npx prisma generate && npm run build

# --- Production stage ---
FROM node:22-bookworm-slim AS production
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build --chown=node:node /app/prisma ./prisma
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
