FROM node:24-slim AS builder

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

WORKDIR /repo

RUN corepack enable

COPY package.json pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY eslint.config.js prettier.config.js ./
COPY apps/server/package.json apps/server/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/storage/package.json packages/storage/package.json

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm --filter @patchpage/server... build

FROM node:24-slim AS runner

ENV NODE_ENV=production
ENV PORT=3000

WORKDIR /repo

COPY --from=builder /repo/package.json /repo/pnpm-workspace.yaml /repo/turbo.json ./
COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/apps/server ./apps/server
COPY --from=builder /repo/packages/config ./packages/config
COPY --from=builder /repo/packages/core ./packages/core
COPY --from=builder /repo/packages/db ./packages/db
COPY --from=builder /repo/packages/storage ./packages/storage

WORKDIR /repo/apps/server

EXPOSE 3000

CMD ["node", "dist/start.js"]
