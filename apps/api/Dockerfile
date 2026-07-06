FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/cli/package.json apps/cli/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/qwen/package.json packages/qwen/package.json
COPY packages/workspace/package.json packages/workspace/package.json
RUN npm ci

FROM deps AS build
COPY apps apps
COPY packages packages
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
# Mission workspaces run `git worktree`/`npm install`/`npm run build` for
# real, so the runtime image needs git and a full npm toolchain, not just
# the Node binary.
RUN apk add --no-cache git
ENV NODE_ENV=production
ENV PORT=8787
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/qwen/package.json packages/qwen/package.json
COPY packages/workspace/package.json packages/workspace/package.json
RUN npm ci --omit=dev --workspace @orvix/api --include-workspace-root=false
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/qwen/dist packages/qwen/dist
COPY --from=build /app/packages/workspace/dist packages/workspace/dist
EXPOSE 8787
CMD ["node", "apps/api/dist/index.js"]
