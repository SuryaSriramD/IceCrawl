FROM node:20-slim
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @icecrawl/engines exec playwright-core install --with-deps chromium
ENV ICECRAWL_BROWSER_NO_SANDBOX=true
EXPOSE 3002
# the API container answers /ready; the worker container has no HTTP port and turns this off in docker-compose.yml
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3002)+'/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["pnpm", "--filter", "@icecrawl/api", "start"]
