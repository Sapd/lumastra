# SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
# SPDX-License-Identifier: AGPL-3.0-only

# Native build/runtime validation image; never selects a deployed implementation.
# Build from the application root with --build-arg COMPONENT=watcher|livetv-proxy|task-queue.
FROM node:24-bookworm-slim AS node-tools
FROM rust:1.99.1-bookworm AS builder
ARG COMPONENT
ENV CARGO_BUILD_JOBS=2
WORKDIR /app
COPY --from=node-tools /usr/local/bin/node /usr/local/bin/node
COPY native/ native/
COPY scripts/native.mjs scripts/native.mjs
RUN node scripts/native.mjs build "$COMPONENT" \
    && node scripts/native.mjs licenses "$COMPONENT"

FROM ubuntu:24.04 AS smoke
ARG COMPONENT
COPY --from=builder /app/build/ /app/build/
ENV NATIVE_COMPONENT=$COMPONENT
# Numeric identity avoids Ubuntu's pre-existing UID 1000 account.
USER 65532:65532
WORKDIR /app
# The image has no Node runtime and runs only the selected executable's version
# command: validates target architecture and glibc linkage, without listening.
CMD ["/bin/sh", "-ec", "case \"$NATIVE_COMPONENT\" in watcher) exec build/lumastra-watcher --version;; livetv-proxy) exec build/lumastra-livetv-proxy --version;; task-queue) exec build/lumastra-task-queue --version;; *) exit 64;; esac"]
