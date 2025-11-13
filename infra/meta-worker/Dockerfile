# syntax=docker/dockerfile:1.4

FROM node:20-alpine AS base

WORKDIR /app

ENV NODE_ENV=production
ENV PNPM_HOME=/root/.local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable && \
    apk add --no-cache bash

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml* ./
COPY packages ./packages
COPY supabase ./supabase
COPY scripts ./scripts
COPY lib ./lib
COPY tsconfig.json ./

RUN pnpm install --frozen-lockfile

COPY . .

CMD ["pnpm", "tsx", "scripts/meta_backfill_worker.ts"]


