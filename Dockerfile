FROM node:22-bookworm-slim

# git/curl for working inside the container; Claude Code for continuing development here
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code

WORKDIR /app

# Claude Code keeps its state (auth, settings, session/project history) here.
# docker-compose.yml mounts the whole home dir on a named volume so it survives
# `docker compose down` / rebuilds.
ENV CLAUDE_CONFIG_DIR=/root/.claude
RUN mkdir -p /root/.claude

EXPOSE 8080

# The repo is volume-mounted at /app (see docker-compose.yml), so the app is
# whatever is checked out there. If package.json is missing the container idles
# instead of crash-looping, so you can exec in and run `claude`.
CMD ["sh", "-c", "if [ -f package.json ]; then npm install && npm start; else echo 'App not implemented yet — see PLAN.md. Container idling.'; sleep infinity; fi"]
