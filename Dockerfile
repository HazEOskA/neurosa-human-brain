FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@11.7.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
COPY examples ./examples
RUN pnpm install --frozen-lockfile

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/*
COPY --from=dependencies /app /app
RUN mkdir /data && chown node:node /data
ENV NODE_ENV=production \
    NEUROSA_API_HOST=0.0.0.0 \
    NEUROSA_ALLOW_REMOTE=true \
    PORT=8080 \
    NEUROSA_DATABASE_PATH=/data/brain.db
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.NEUROSA_API_PORT||process.env.PORT||8080)+'/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Railway volumes can mount root:root; normalize exact DB directory/files at boot then drop privileges.
CMD ["sh","-ec","if [ -d /persist ]; then chown node:node /persist; if [ -n \"${NEUROSA_DATABASE_PATH:-}\" ]; then case \"$NEUROSA_DATABASE_PATH\" in /persist/*) for f in \"$NEUROSA_DATABASE_PATH\" \"$NEUROSA_DATABASE_PATH-wal\" \"$NEUROSA_DATABASE_PATH-shm\"; do if [ -e \"$f\" ]; then chown node:node \"$f\"; fi; done ;; esac; fi; fi; exec gosu node node --import tsx apps/brain-api/src/server.ts"]
