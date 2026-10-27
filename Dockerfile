# syntax=docker/dockerfile:1
# Three stages: compile, install production deps, then a small runtime image
# with neither the compiler nor dev dependencies. No secret is ever copied in
# or passed as a build argument: keys come from the environment at run time.

FROM node:24-slim AS base
WORKDIR /app
RUN npm install -g pnpm@12.9.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

FROM base AS build
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
RUN pnpm build

FROM base AS deps
RUN pnpm install --frozen-lockfile --prod

FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000
# Owned by root and only readable by the app user: the service never writes to disk.
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist/src ./dist/src
COPY config ./config
COPY prompts ./prompts
# The commit this image was built from. Not a secret; it goes on every response.
ARG GIT_SHA=unknown
ENV GIT_SHA=${GIT_SHA}
# The official image's unprivileged user (uid 1000).
USER node
EXPOSE 3000
# Exec form: node is PID 1 and gets SIGTERM directly, for a graceful shutdown.
CMD ["node", "dist/src/server/main.js"]
