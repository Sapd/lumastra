#!/bin/sh
# SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
# SPDX-License-Identifier: AGPL-3.0-only
set -u

# Rust is the only implementation. Refuse stale fallback settings explicitly.
case "$(printf '%s' "${LIVETV_PROXY_RUNTIME:-rust}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')" in
    rust) ;;
    *) echo "Only the Rust Live TV proxy is supported; remove LIVETV_PROXY_RUNTIME" >&2; exit 64 ;;
esac
if [ ! -x build/lumastra-livetv-proxy ]; then
    echo "Rust Live TV proxy binary is unavailable" >&2
    exit 78
fi
sh scripts/fetch-ffmpeg.sh
exec build/lumastra-livetv-proxy --serve
