# The Positive app template, on its own: @foodpilot/app-bridge comes from npm.
FROM node:22-alpine AS dev-stage

WORKDIR /app
EXPOSE 3000
# One process: the Express server, with Vite as middleware for the embedded page (served under /app/).
CMD ["sh", "-c", "npm install && npm run dev"]

FROM node:22-alpine AS build-stage

WORKDIR /app
COPY . .
RUN npm install --no-audit --no-fund && npm run build && npm prune --omit=dev

FROM node:22-alpine AS prod-stage

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build-stage /app/package.json ./package.json
COPY --from=build-stage /app/node_modules ./node_modules
COPY --from=build-stage /app/dist ./dist

RUN mkdir var && chown node:node var
USER node
VOLUME ["/app/var"]
EXPOSE 3000
CMD ["node", "dist/index.js"]
