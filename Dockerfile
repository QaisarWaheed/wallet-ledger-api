# --- Build stage: compile TypeScript ---------------------------------------
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# --- Runtime stage: production dependencies + compiled JS only -------------
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

USER node
EXPOSE 8080
# Exec form so Node is PID 1 and receives SIGTERM directly (graceful shutdown).
CMD ["node", "dist/server.js"]
