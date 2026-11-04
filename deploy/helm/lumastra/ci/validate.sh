#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
# SPDX-License-Identifier: AGPL-3.0-only
#
# Chart gate: helm lint (strict) + helm template | kubeconform for every ci/*-values.yaml profile,
# a determinism check (two renders must be byte-identical), and the helm-unittest suites.
# Needs: helm (3.14+ or 4), kubeconform, the helm-unittest plugin.
#   deploy/helm/lumastra/ci/validate.sh
set -euo pipefail
CHART=$(cd "$(dirname "$0")/.." && pwd)
K8S_VERSION=${K8S_VERSION:-1.33.0}
# Pinned catalog commit so the gate cannot change colour without a chart change.
CRD_CATALOG_REF=${CRD_CATALOG_REF:-d373c2da9702bc9509a004db83e57263fe3bdfc1}
CRD_CATALOG="https://raw.githubusercontent.com/datreeio/CRDs-catalog/${CRD_CATALOG_REF}/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

fail=0
for values in "$CHART"/ci/*-values.yaml; do
    name=$(basename "$values" -values.yaml)
    echo "── $name"
    helm lint --strict -f "$values" "$CHART" >"$TMP/lint.txt" 2>&1 || { cat "$TMP/lint.txt"; fail=1; continue; }
    helm template "lumastra-$name" "$CHART" -n lumastra -f "$values" >"$TMP/$name.yaml"
    helm template "lumastra-$name" "$CHART" -n lumastra -f "$values" >"$TMP/$name.again.yaml"
    if ! cmp -s "$TMP/$name.yaml" "$TMP/$name.again.yaml"; then
        echo "not deterministic: two renders differ"; fail=1
    fi
    # Every location that proxies to web sets the router-hop header exactly once (the header also
    # overwrites a client-sent copy, so a missing line would let a client's value through).
    pass_n=$(grep -c 'proxy_pass http://lumastra_web;' "$TMP/$name.yaml" || true)
    hop_n=$(grep -c 'proxy_set_header X-Lumastra-Router-Hop \$lumastra_hop;' "$TMP/$name.yaml" || true)
    if [ "$pass_n" != "$hop_n" ]; then
        echo "router: $pass_n proxy_pass to web but $hop_n hop header lines"; fail=1
    fi
    # Barman Cloud's ObjectStore has no published schema in the catalog yet.
    kubeconform -strict -summary -kubernetes-version "$K8S_VERSION" \
        -schema-location default -schema-location "$CRD_CATALOG" \
        -skip ObjectStore \
        "$TMP/$name.yaml" || fail=1
done

# Guards: combinations that would deploy but not work must refuse to render.
echo "── guards"
expect_fail() {
    local want=$1; shift
    if out=$(helm template guard "$CHART" --set secrets.existingSecret=s "$@" 2>&1); then
        echo "expected a render failure ($want) for: $*"; fail=1
    elif ! grep -q -- "$want" <<<"$out"; then
        echo "render failed for: $* — but not with \"$want\":"; echo "$out" | tail -2; fail=1
    fi
}
expect_fail 'auth.forwardAuth needs networkPolicy.enabled' --set auth.forwardAuth.enabled=true --set auth.forwardAuth.trustedProxyIps=10.0.0.0/8
expect_fail 'trustedProxyIps is required' --set auth.forwardAuth.enabled=true --set networkPolicy.enabled=true
expect_fail 'persistence.config.enabled=false is unsupported' --set persistence.config.enabled=false
expect_fail 'worker.replicas must be 0 or 1' --set worker.replicas=2
expect_fail 'valkey.tasks.replicas must be 0 or 1' --set valkey.tasks.replicas=2
expect_fail 'sonic.replicas must be 0 or 1' --set sonic.enabled=true --set sonic.replicas=2 --set sonic.database.existingSecret=s
expect_fail 'web.replicas must be >= 0' --set web.replicas=-1
expect_fail 'FEATURE_USER_PATS: expected true, false or null' --set auth.userPats=yes
expect_fail 'database.cnpg.initdb.lcCollate is not supported' --set database.mode=cnpg --set database.cnpg.initdb.lcCollate=C
expect_fail 'need localeProvider: icu' --set database.mode=cnpg --set database.cnpg.initdb.icuLocale=en-US
expect_fail 'rdbImport needs valkey.tasks.persistence.enabled' --set valkey.tasks.rdbImport.enabled=true --set valkey.tasks.persistence.enabled=false
expect_fail 'mode must be split' --set mode=cluster
expect_fail 'mode must be split' --set mode=allInOne
expect_fail 'allInOne values were removed' --set allInOne.replicas=1
expect_fail 'valkey.single was removed' --set valkey.single=true
expect_fail 'needs persistence.ffmpegCache.enabled' --set proxy.enabled=true
expect_fail 'web: no sign-in method' --set auth.native.enabled=false
echo "ok"

echo "── helm unittest"
helm unittest "$CHART" || fail=1
exit $fail
