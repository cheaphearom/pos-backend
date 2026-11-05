FROM node:22-alpine AS build
RUN apk add --no-cache openssl
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/
COPY apps/api/prisma apps/api/prisma
RUN npm ci -w apps/api --include-workspace-root
COPY apps/api apps/api
RUN npm run db:generate -w apps/api && npm run build -w apps/api

FROM node:22-alpine
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api ./apps/api
WORKDIR /app/apps/api
EXPOSE 3000
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
