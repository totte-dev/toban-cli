# toban/agent - Official Toban Agent Docker Image
# Pre-installs Claude Code CLI and other agent tools
# Agents run inside this container with filesystem isolation

FROM node:20-slim

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Create non-root user for agent execution
RUN useradd -m -s /bin/bash agent

# Set up workspace directory
RUN mkdir -p /workspace && chown agent:agent /workspace

# Switch to non-root user
USER agent
WORKDIR /workspace

# Default entrypoint: run claude with provided arguments
ENTRYPOINT ["claude"]
