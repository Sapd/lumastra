// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The one definition of how a task's cache keys are namespaced in Valkey.
 *
 * `buildNamespacedCache(pluginId)` prefixes every key a task writes, so the
 * logical key a task uses (`hwaccel-deny:/dev/dri/renderD128:hevc:yuv420p`)
 * is NOT the key that exists in Valkey. Anything that has to reach those keys
 * directly — an admin SCAN, a TTL read, a targeted DEL — must reconstruct the
 * same prefix, and a hand-copied `'plugin:trickplay-generation:'` string
 * literal is exactly the kind of mirror that goes silently stale: it does not
 * fail loudly, it just scans a keyspace nothing ever wrote to and reports
 * "nothing is denied" while the latch is still very much on.
 *
 * This module is deliberately dependency-free so a read path can import it
 * without pulling the task registry (and its config side effects) in with it.
 */
export function namespacedCacheKeyPrefix(pluginId: string): string {
    return `plugin:${pluginId}:`;
}
