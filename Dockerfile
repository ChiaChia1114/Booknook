# Athena-sky – private deployment image (server + web app + simulator CLI)
#   docker build -t athena-sky .
#   docker run -p 8080:8080 -v athena-data:/data athena-sky            # production
#   docker run -p 8080:8080 athena-sky node apps/server/dist/main.js --demo   # demo with virtual drones

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/simulator/package.json apps/simulator/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    ATHENA_DATA_DIR=/data
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/simulator/package.json apps/simulator/
COPY apps/web/package.json apps/web/
# Only the runtime dependencies of the server and the simulator (the web app is pre-built).
RUN npm ci --omit=dev --no-audit --no-fund -w @athena-sky/server -w @athena-sky/simulator --include-workspace-root=false \
    && npm cache clean --force \
    && mkdir -p /data && chown node:node /data
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/simulator/dist apps/simulator/dist
COPY --from=build /app/apps/web/dist apps/web/dist
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "apps/server/dist/main.js"]
