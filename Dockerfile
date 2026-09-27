FROM node:22-bookworm-slim

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

ENV NODE_ENV=production
EXPOSE 9090
CMD ["pnpm", "start:docker"]
