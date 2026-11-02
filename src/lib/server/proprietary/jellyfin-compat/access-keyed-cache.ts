// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * A small in-process TTL cache for aggregates computed over "everything this
 * user may see" (genre lists, filter menus). Entries are keyed by the access
 * boundary — denied library groups AND the age rule — plus a caller key, so
 * two requests share an entry only when they see exactly the same rows. The
 * pending promise is cached, so concurrent misses run the query once; a
 * failed load is not remembered.
 */

import type { JellyfinAccessContext } from './access-context';

export function accessCacheKey(access: JellyfinAccessContext): string {
    const denied = [...(access.deniedGroupIds ?? [])].sort().join(',');
    const age = access.ageRating;
    return `${denied}|${age?.maxAgeRating ?? 'any'}|${age?.allowUnrated ?? ''}`;
}

export class AccessKeyedCache<T> {
    private readonly entries = new Map<string, { expiresAt: number; value: Promise<T> }>();

    /**
     * @param maxPerAccess optional cap on live entries per access key. Caller
     *   keys can be client-controlled (type lists, ParentId), so without it one
     *   user cycling variants would evict every other user's entries from the
     *   shared FIFO; with it the user evicts only their own oldest variant.
     */
    constructor(
        private readonly ttlMs: number,
        private readonly maxEntries: number,
        private readonly maxPerAccess?: number,
    ) {}

    get(access: JellyfinAccessContext, key: string, load: () => Promise<T>): Promise<T> {
        const accessKey = accessCacheKey(access);
        const fullKey = `${key}#${accessKey}`;
        const now = Date.now();
        const hit = this.entries.get(fullKey);
        if (hit && hit.expiresAt > now) return hit.value;
        this.entries.delete(fullKey);
        if (this.maxPerAccess !== undefined) {
            const suffix = `#${accessKey}`;
            const own = [...this.entries.keys()].filter((k) => k.endsWith(suffix));
            // Map iteration is insertion order, so own[0] is this user's oldest.
            if (own.length >= this.maxPerAccess) this.entries.delete(own[0]);
        }
        if (this.entries.size >= this.maxEntries) {
            const oldest = this.entries.keys().next().value;
            if (oldest !== undefined) this.entries.delete(oldest);
        }
        const value = load();
        this.entries.set(fullKey, { expiresAt: now + this.ttlMs, value });
        value.catch(() => {
            if (this.entries.get(fullKey)?.value === value) this.entries.delete(fullKey);
        });
        return value;
    }

    clear(): void {
        this.entries.clear();
    }
}
