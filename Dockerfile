FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
COPY tsconfig.json tsconfig.build.json ./
COPY nest-cli.json ./
COPY src ./src

RUN npm install
RUN npm run build

FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

ENV PORT=3333
EXPOSE 3333

CMD ["node", "dist/main.js"]
