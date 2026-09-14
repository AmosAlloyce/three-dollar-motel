FROM node:22-bookworm-slim

ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app

# No npm install or build step: the app uses Node's standard library.
COPY --chown=node:node package.json server.mjs passport.mjs index.html ./
COPY --chown=node:node public/ ./public/
RUN mkdir /app/data && chown node:node /app/data && chmod 700 /app/data

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "server.mjs"]
