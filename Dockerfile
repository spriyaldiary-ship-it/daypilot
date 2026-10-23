# DayPilot - build the UI, then run the API + UI on one port.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DB_FILE=/data/daypilot.db TRUST_PROXY=1 SEED_SAMPLE_DATA=0
COPY --from=build /app/package.json ./
COPY --from=build /app/server ./server
COPY --from=build /app/client/dist ./client/dist
COPY --from=build /app/node_modules ./node_modules
VOLUME /data
EXPOSE 3000
# APP_PASSWORD must be provided at run time, otherwise the server refuses to start.
CMD ["node", "--disable-warning=ExperimentalWarning", "server/src/index.js"]
