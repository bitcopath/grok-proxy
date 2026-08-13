FROM node:20-bookworm-slim

# curl for CLI install + healthcheck; ca-certificates for HTTPS
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates bash \
    && rm -rf /var/lib/apt/lists/*

# Install Grok Build CLI.
# The installer puts the real binary under $HOME/.grok/downloads and only
# symlinks into GROK_BIN_DIR. We copy a real binary into /usr/local/bin so
# mounting /root/.grok (auth/config) cannot accidentally hide the CLI.
ENV HOME=/root
ENV GROK_BIN_DIR=/usr/local/bin
RUN curl -fsSL https://x.ai/cli/install.sh | bash \
    && cp -aL /usr/local/bin/grok /usr/local/bin/grok.real \
    && mv /usr/local/bin/grok.real /usr/local/bin/grok \
    && chmod 755 /usr/local/bin/grok \
    && if [ -L /usr/local/bin/agent ] || [ -e /usr/local/bin/agent ]; then \
         cp -aL /usr/local/bin/agent /usr/local/bin/agent.real \
         && mv /usr/local/bin/agent.real /usr/local/bin/agent \
         && chmod 755 /usr/local/bin/agent; \
       fi \
    && /usr/local/bin/grok --version

WORKDIR /app

COPY package.json .
RUN npm install --omit=dev

COPY server.js entrypoint.sh ./
RUN chmod +x /app/entrypoint.sh \
    && mkdir -p /app/data /app/logs

EXPOSE 8080

ENTRYPOINT ["/app/entrypoint.sh"]
