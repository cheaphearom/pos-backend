FROM node:22-alpine AS build
# node:22-alpine already has the SSL library Prisma needs (libssl 3): no packages to install.
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/
COPY apps/api/prisma apps/api/prisma
RUN npm ci -w apps/api --include-workspace-root
COPY apps/api apps/api
RUN npm run db:generate -w apps/api && npm run build -w apps/api

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api ./apps/api
WORKDIR /app/apps/api
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 CMD wget -qO- http://127.0.0.1:3000/health >/dev/null || exit 1
# Database changes first, then the first admin (only on an empty database), then the API.
CMD ["sh", "-c", "npx prisma migrate deploy && node prisma/bootstrap.mjs && node dist/main.js"]
