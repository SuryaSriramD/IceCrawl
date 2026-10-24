FROM node:20-slim
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @icecrawl/engines exec playwright-core install --with-deps chromium
ENV ICECRAWL_BROWSER_NO_SANDBOX=true
EXPOSE 3002
CMD ["pnpm", "--filter", "@icecrawl/api", "start"]
