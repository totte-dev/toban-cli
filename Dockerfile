# toban/agent - Official Toban Agent Docker Image
# Pre-installs Claude Code CLI and other agent tools
# Agents run inside this container with filesystem isolation

FROM node:20-slim

# Install system dependencies + GitHub CLI
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    gpg \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       | gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && apt-get purge -y gpg && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# Install coding agent CLIs globally
RUN npm install -g @anthropic-ai/claude-code \
    && npm install -g @google/gemini-cli \
    && npm install -g @openai/codex \
    && npm cache clean --force

# Create non-root user for agent execution
RUN useradd -m -s /bin/bash agent

# Set up workspace directories
RUN mkdir -p /workspace /workspace-agent && chown agent:agent /workspace /workspace-agent

# Add entrypoint script for worktree isolation
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Switch to non-root user
USER agent
WORKDIR /workspace

ENTRYPOINT ["/entrypoint.sh"]
CMD ["bash"]
