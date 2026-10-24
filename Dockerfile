FROM node:20-slim
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
EXPOSE 3002
CMD ["pnpm", "--filter", "@icecrawl/api", "start"]
