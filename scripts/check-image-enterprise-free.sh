#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
# SPDX-License-Identifier: AGPL-3.0-only

# Artifact-side tripwire for the open-core image: FAIL if a built image carries any
# Enterprise-tier path (LICENSING.md §3.2).
#
# The open-core image is built from the `.publicignore`-filtered tree, so it structurally
# cannot contain Enterprise code — every SOURCE-side leak already has a gate
# (check-license-boundary.mjs, the `.publicignore` <-> ENTERPRISE_PREFIXES sync note). This
# checks the shipped ARTIFACT instead, which nothing else does.
#
# It lists the image's filesystem via `docker create` + `docker export` (the image is never
# RUN, so no entrypoint, no shell and no `find` binary are needed inside it) and matches
# every path under /app case-INsensitively against "enterprise". That is deliberately
# broader than the tier layout (`enterprise/`, `(enterprise)/`): a renamed or compiled leak
# (e.g. a server chunk named after an enterprise route) still trips it.
#
# Known name-only false positives are ALLOWLISTED by exact path below — each entry must be
# an AGPL file that merely has "Enterprise" in its name. Keep the list short and exact.
#
# Usage: scripts/check-image-enterprise-free.sh <image-ref>
set -euo pipefail

image="${1:?usage: check-image-enterprise-free.sh <image-ref>}"

# Exact paths (as `tar -t` prints them: no leading slash). Extended regex, anchored.
allow=(
	# AGPL nav badge that labels enterprise menu entries; carries no enterprise logic.
	'^app/src/lib/components/admin/nav/EnterpriseBadge\.svelte$'
	# Paraglide compiles ONE module per i18n key into src/lib/paraglide/messages/ (the image
	# ships the builder's src/). Keys like `setup_usecase_enterprise` become file names. They
	# are translated strings compiled from the public messages/*.json — never code. Only
	# direct children of that directory, only .js.
	'^app/src/lib/paraglide/messages/[a-z0-9_]+\.js$'
	# This tripwire itself: the runtime stage copies the whole scripts/ directory.
	'^app/scripts/check-image-enterprise-free\.sh$'
)

listing="$(mktemp)"
cid="$(docker create "$image")"
trap 'docker rm -f "$cid" >/dev/null 2>&1 || true; rm -f "$listing"' EXIT
docker export "$cid" | tar -tf - >"$listing"

total="$(grep -c '^app/' "$listing" || true)"
if [ "${total:-0}" -eq 0 ]; then
	# An empty listing would make the check pass vacuously — refuse instead.
	echo "check-image-enterprise-free: no paths under /app in $image — wrong image?" >&2
	exit 2
fi

hits="$(grep '^app/' "$listing" | grep -i 'enterprise' || true)"
for pattern in "${allow[@]}"; do
	[ -n "$hits" ] || break
	hits="$(printf '%s\n' "$hits" | grep -Ev "$pattern" || true)"
done

if [ -n "$hits" ]; then
	count="$(printf '%s\n' "$hits" | wc -l | tr -d ' ')"
	echo "check-image-enterprise-free FAILED — $count Enterprise-looking path(s) in $image:" >&2
	printf '%s\n' "$hits" | head -50 | sed 's/^/  \//' >&2
	echo "The open-core image must be built from the .publicignore-filtered tree." >&2
	echo "If a hit is an AGPL file that only has 'enterprise' in its name, allowlist its exact path in $0." >&2
	exit 1
fi

echo "check-image-enterprise-free OK — $total paths under /app, none Enterprise ($image)"
