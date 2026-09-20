# cyc-testbench/codex:<version>
ARG BASE_IMAGE=cyc-testbench/base:2026-09-02
FROM ${BASE_IMAGE}
ARG HARNESS_VERSION=0.148.0
ARG HARNESS_PACKAGE=@openai/codex

# The npm shim pulls the platform binary through optionalDependencies at
# build time. No cache is left under /root.
RUN npm install -g --no-fund --no-audit "${HARNESS_PACKAGE}@${HARNESS_VERSION}" \
 && rm -rf /root/.npm /root/.cache /tmp/* \
 && codex --version

ENV CYC_HARNESS=codex \
    CYC_HARNESS_VERSION=${HARNESS_VERSION}

RUN if grep -rl "sk-" /root 2>/dev/null; then echo "TRIPWIRE: key-like content under /root" >&2; exit 1; fi
