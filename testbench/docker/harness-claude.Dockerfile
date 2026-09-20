# cyc-testbench/claude:<version>
ARG BASE_IMAGE=cyc-testbench/base:2026-09-02
FROM ${BASE_IMAGE}
ARG HARNESS_VERSION=2.1.257
ARG HARNESS_PACKAGE=@anthropic-ai/claude-code

# The npm package's postinstall fetches the native claude binary; that is the
# one network fetch, at build time. No cache is left under /root.
RUN npm install -g --no-fund --no-audit "${HARNESS_PACKAGE}@${HARNESS_VERSION}" \
 && rm -rf /root/.npm /root/.cache /tmp/* \
 && claude --version

# Baked defaults every cell inherits (adapters-open-questions Q3: updater and
# telemetry off; the fake model is the only peer, so nonessential traffic is
# off too). The per-cell home and base url are set by the driver.
ENV DISABLE_AUTOUPDATER=1 \
    DISABLE_TELEMETRY=1 \
    DISABLE_ERROR_REPORTING=1 \
    DISABLE_BUG_COMMAND=1 \
    DO_NOT_TRACK=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    CYC_HARNESS=claude \
    CYC_HARNESS_VERSION=${HARNESS_VERSION}

RUN if grep -rl "sk-" /root 2>/dev/null; then echo "TRIPWIRE: key-like content under /root" >&2; exit 1; fi
