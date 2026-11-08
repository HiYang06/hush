# Built from the repo root's server/ and src/shared/ (deploy.sh copies just those): the server imports the
# protocol types from src/shared/sync.ts. Node 24 runs TypeScript directly, so there is no build step.
FROM node:24-alpine
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY src/shared/sync.ts src/shared/package.json /app/src/shared/
COPY server/src ./src
COPY server/migrations ./migrations
COPY server/public ./public
ENV NODE_ENV=production
USER node
CMD ["node", "src/index.ts"]
