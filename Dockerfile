# syntax=docker/dockerfile:1

# Base image pinned by digest (reproducible builds; bump deliberately, e.g. with Dependabot).
# node:24-slim
ARG NODE_IMAGE=node:24-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c

# ---- build: all dependencies + TypeScript compiler -> dist/ ----
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- runtime: production dependencies + compiled JS only ----
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Unprivileged user that ships with the official node image.
USER node
EXPOSE 8080
# Exec form: node is PID 1 and receives SIGTERM directly (graceful shutdown on Cloud Run).
CMD ["node", "dist/server.js"]
