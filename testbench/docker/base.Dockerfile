# cyc-testbench/base:<date>
#
# Everything a cell needs except the harness itself: tmux 3.4 (distro), herdr
# 0.8.2 (static release binary), bun (runs the engine, the fake model, the
# driver), node 22 (pi is a node program; claude/codex/opencode ship native
# binaries but are installed through npm), python3 (the announce hook), and the
# engine's npm dependencies baked at /opt/engine-deps so a cell can run the
# engine with --network none.
#
# Build context: testbench/artifacts/ctx (prepared by run.ts), which holds
#   deps/agent-engine/{package.json,bun.lock,patches/}
#   deps/mcp/{package.json,bun.lock}
# No file from any home directory is ever copied in. The last step is the
# key tripwire: the build fails if anything under /root contains "sk-".

FROM ubuntu:24.04

ARG BUN_VERSION=1.4.0
ARG NODE_VERSION=22.14.0
ARG HERDR_VERSION=0.8.2

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    TERM=xterm-256color \
    BUN_INSTALL=/opt/bun \
    BUN_INSTALL_CACHE_DIR=/tmp/bun-cache \
    PATH=/opt/bun/bin:/opt/node/bin:/usr/local/bin:/usr/bin:/bin

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip xz-utils git python3 procps tmux coreutils iproute2 \
 && rm -rf /var/lib/apt/lists/* \
 && tmux -V

# bun: official release zip, pinned.
RUN curl -fsSL -o /tmp/bun.zip \
      "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" \
 && mkdir -p /opt/bun/bin \
 && unzip -q /tmp/bun.zip -d /tmp/bun \
 && mv /tmp/bun/bun-linux-x64/bun /opt/bun/bin/bun \
 && chmod +x /opt/bun/bin/bun \
 && rm -rf /tmp/bun /tmp/bun.zip \
 && bun --version

# node: official tarball, pinned. Needed by pi (a node program) and by npm,
# which installs the other harnesses in the harness-*.Dockerfiles.
RUN curl -fsSL -o /tmp/node.tar.xz \
      "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
 && mkdir -p /opt/node \
 && tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1 \
 && rm -f /tmp/node.tar.xz \
 && node --version && npm --version

# herdr: static-pie release binary, pinned.
RUN curl -fsSL -o /usr/local/bin/herdr \
      "https://github.com/herdrdev/herdr/releases/download/v${HERDR_VERSION}/herdr-linux-x86_64" \
 && chmod +x /usr/local/bin/herdr \
 && herdr --version

# Engine dependencies, installed from the repo's own lockfile (werift is a
# patched dependency; bun install applies patches/). The cell symlinks these
# into its private copy of the engine tree as node_modules.
COPY deps/agent-engine /opt/engine-deps/agent-engine
COPY deps/mcp /opt/engine-deps/mcp
RUN cd /opt/engine-deps/agent-engine && bun install --frozen-lockfile --no-summary \
 && cd /opt/engine-deps/mcp && bun install --no-summary \
 && rm -rf /tmp/bun-cache /root/.bun /root/.npm /root/.cache

# Cell layout: everything a cell writes lives under /cell; /out is the
# artifact bind mount; /engine is the read-only bind mount of the repo.
RUN mkdir -p /cell /out /engine

# Key tripwire (brief, hard rules): no file under /root may contain "sk-".
# grep exits 1 when nothing matches, which is the only passing outcome.
RUN if grep -rl "sk-" /root 2>/dev/null; then echo "TRIPWIRE: key-like content under /root" >&2; exit 1; fi

WORKDIR /cell
