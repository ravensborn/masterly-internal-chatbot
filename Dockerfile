FROM node:22-bookworm-slim

# git/curl for working inside the container; Claude Code for continuing development here
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code

WORKDIR /app

EXPOSE 8080

# The repo is volume-mounted at /app (see docker-compose.yml). Until the chat
# server is implemented (see PLAN.md) the container idles so you can exec in
# and run `claude` to continue development.
CMD ["sh", "-c", "if [ -f package.json ]; then npm install && npm start; else echo 'App not implemented yet — see PLAN.md. Container idling.'; sleep infinity; fi"]
