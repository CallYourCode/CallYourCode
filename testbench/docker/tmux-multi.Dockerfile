# cyc-testbench/tmux-multi:<tag>  (nightly compat tier only)
#
# Builds the compat tmux versions from source into /opt/tmux/<version>/bin
# so a nightly cell can put one of them first on PATH. The pr tier uses the
# distro tmux 3.4 baked into the base image; this image is not built for pr.
ARG BASE_IMAGE=cyc-testbench/base:2026-09-02
FROM ${BASE_IMAGE}
ARG TMUX_VERSIONS="3.2a 3.3a 3.5a 3.7b"

RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential libevent-dev libncurses-dev bison pkg-config \
 && for v in ${TMUX_VERSIONS}; do \
      curl -fsSL -o /tmp/tmux-$v.tar.gz "https://github.com/tmux/tmux/releases/download/$v/tmux-$v.tar.gz" \
      && mkdir -p /tmp/tmux-$v && tar -xzf /tmp/tmux-$v.tar.gz -C /tmp/tmux-$v --strip-components=1 \
      && (cd /tmp/tmux-$v && ./configure --prefix=/opt/tmux/$v >/dev/null && make -j2 >/dev/null && make install >/dev/null) \
      && /opt/tmux/$v/bin/tmux -V ; \
    done \
 && apt-get purge -y build-essential libevent-dev libncurses-dev bison pkg-config \
 && apt-get autoremove -y && rm -rf /var/lib/apt/lists/* /tmp/tmux-*

RUN if grep -rl "sk-" /root 2>/dev/null; then echo "TRIPWIRE: key-like content under /root" >&2; exit 1; fi
