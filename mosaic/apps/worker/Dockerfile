# Node 22 runs the TypeScript sources directly via type stripping, so there is
# no build step and no compiled output to keep in sync.
FROM node:22-bookworm-slim

# ffmpeg and ffprobe are the whole reason this service exists.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/montage/package.json packages/montage/
COPY apps/worker/package.json apps/worker/
RUN npm ci --omit=dev --workspace @mosaic/worker --include-workspace-root

COPY packages/montage packages/montage
COPY apps/worker apps/worker

ENV NODE_ENV=production
WORKDIR /app/apps/worker
CMD ["node", "src/index.ts"]
