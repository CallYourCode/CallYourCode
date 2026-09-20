# cyc-testbench/opencode:<version>
ARG BASE_IMAGE=cyc-testbench/base:2026-09-02
FROM ${BASE_IMAGE}
ARG HARNESS_VERSION=1.18.19
ARG HARNESS_PACKAGE=opencode-ai

RUN npm install -g --no-fund --no-audit "${HARNESS_PACKAGE}@${HARNESS_VERSION}" \
 && rm -rf /root/.npm /root/.cache /tmp/* \
 && opencode --version

# Q3: no self-upgrade, no models.dev fetch. Homes inside the cell: the same
# XDG paths are used at build (below) and at run, so the provider SDK that
# opencode npm-installs at first use is already there for --network none.
ENV OPENCODE_DISABLE_AUTOUPDATE=1 \
    OPENCODE_DISABLE_MODELS_FETCH=1 \
    XDG_CONFIG_HOME=/cell/home/.config \
    XDG_DATA_HOME=/cell/home/.local/share \
    XDG_STATE_HOME=/cell/home/.local/state \
    XDG_CACHE_HOME=/cell/home/.cache \
    CYC_HARNESS=opencode \
    CYC_HARNESS_VERSION=${HARNESS_VERSION}

# Pre-warm: on first use opencode npm-installs @opencode-ai/plugin@<version>
# into $XDG_CONFIG_HOME/opencode/node_modules (what the cyc plugin imports;
# @ai-sdk/openai-compatible itself ships bundled in 1.18). Run one headless
# turn against a port nobody answers: the model call fails ("Cannot connect
# to API"), the install (the only network fetch) has happened. The cell
# rewrites opencode.json with the live fake-model port at start.
RUN mkdir -p /cell/home/.config/opencode /cell/work \
 && printf '%s\n' '{ "$schema": "https://opencode.ai/config.json", "autoupdate": false, "provider": { "fake": { "npm": "@ai-sdk/openai-compatible", "name": "fake", "options": { "baseURL": "http://127.0.0.1:1/v1", "apiKey": "dummy" }, "models": { "fake-model": { "name": "fake", "limit": { "context": 128000, "output": 8192 } } } } } }' \
      > /cell/home/.config/opencode/opencode.json \
 && cd /cell/work && HOME=/cell/home timeout 90 opencode run -m fake/fake-model "warm" 2>&1 | tail -3 ; \
    test -f /cell/home/.config/opencode/node_modules/@opencode-ai/plugin/package.json \
 && rm -rf /root/.npm /root/.cache /tmp/* /cell/home/.npm /cell/home/.local/share/opencode/*.db* /cell/home/.local/share/opencode/log /cell/home/.local/state

RUN if grep -rl "sk-" /root 2>/dev/null; then echo "TRIPWIRE: key-like content under /root" >&2; exit 1; fi
