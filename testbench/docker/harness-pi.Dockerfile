# cyc-testbench/pi:<version>
ARG BASE_IMAGE=cyc-testbench/base:2026-09-02
FROM ${BASE_IMAGE}
ARG HARNESS_VERSION=0.84.3
ARG HARNESS_PACKAGE=@earendil-works/pi-coding-agent

# pi is a node program; --ignore-scripts keeps any postinstall from reaching
# out. No cache is left under /root.
RUN npm install -g --no-fund --no-audit --ignore-scripts "${HARNESS_PACKAGE}@${HARNESS_VERSION}" \
 && rm -rf /root/.npm /root/.cache /tmp/* \
 && pi --version

# Q3: no update check, no telemetry, offline.
ENV PI_SKIP_VERSION_CHECK=1 \
    PI_TELEMETRY=0 \
    PI_OFFLINE=1 \
    CYC_HARNESS=pi \
    CYC_HARNESS_VERSION=${HARNESS_VERSION}

RUN if grep -rl "sk-" /root 2>/dev/null; then echo "TRIPWIRE: key-like content under /root" >&2; exit 1; fi
