# Self-hosted Chromium worker. Vercel runs only the web/API application.
# Pin both Playwright and the image to the same version. No Browserbase services are used.
FROM mcr.microsoft.com/playwright:v1.64.0-noble
WORKDIR /opt/canvasly
COPY worker/package.json ./worker/package.json
RUN cd worker && npm install --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=pwuser:pwuser lib ./lib
COPY --chown=pwuser:pwuser public/domain.mjs ./public/domain.mjs
COPY --chown=pwuser:pwuser worker ./worker
USER pwuser
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
# Chromium sandbox is explicitly enabled in code; unsupported hosts fail closed.
CMD ["node", "worker/server.mjs"]
