# --- Build stage ---
FROM node:22-bookworm-slim AS build
WORKDIR /app
# openssl so Prisma's engines detect libssl cleanly (this stage also runs the
# one-shot `prisma migrate deploy` migrate service — keeps its deploy logs clean).
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
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
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "dist/main.js"]
