FROM node:24-slim AS builder

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

WORKDIR /repo

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY eslint.config.js prettier.config.js ./
COPY apps/server/package.json apps/server/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/storage/package.json packages/storage/package.json

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm --filter @patchpage/server... build \
  && find \
    apps/server/dist \
    packages/config/dist \
    packages/core/dist \
    packages/db/dist \
    packages/storage/dist \
    -type f \( -name '*.d.ts' -o -name '*.map' \) -delete \
  && pnpm --filter @patchpage/server deploy --prod --legacy /runtime

FROM node:24-slim AS runner

ARG VERSION=0.0.0-dev
ARG REVISION=unknown

LABEL org.opencontainers.image.source="https://github.com/allisonmahmood/PatchPage" \
  org.opencontainers.image.licenses="MIT" \
  org.opencontainers.image.version="$VERSION" \
  org.opencontainers.image.revision="$REVISION"

ENV NODE_ENV=production
ENV PORT=3000
ENV PATCHPAGE_DB_FILE=/data/patchpage-db.json
ENV PATCHPAGE_STORAGE_DIR=/data/drafts

WORKDIR /app

RUN rm -rf \
    /opt/yarn-* \
    /usr/local/include/node \
    /usr/local/lib/node_modules/corepack \
    /usr/local/lib/node_modules/npm \
    /usr/local/share/doc/node \
    /usr/local/share/man/man1/node.1 \
  && rm -f \
    /usr/local/bin/corepack \
    /usr/local/bin/npm \
    /usr/local/bin/npx \
    /usr/local/bin/pnpm \
    /usr/local/bin/pnpx \
    /usr/local/bin/yarn \
    /usr/local/bin/yarnpkg \
  && mkdir /data \
  && chown node:node /data

COPY --from=builder /runtime/ ./
COPY LICENSE ./LICENSE

VOLUME ["/data"]

USER node

EXPOSE 3000

CMD ["node", "dist/start.js"]
