// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** File evidence is sync-only: it must never create TMDB/IMDb identities. */
export interface SyncFile {
    path: string;
    roots?: string[];
    size?: string | number | null;
}
export interface SyncFileItem {
    id: string;
    mediaType: string;
    title?: string;
    providerIds?: { tmdb?: string; imdb?: string };
    /** Unsupported combined files still participate in ambiguity detection. */
    pairable?: boolean;
    /** Episode position (season, first and last episode number), when known. */
    season?: number | null;
    episode?: number | null;
    episodeEnd?: number | null;
    files: SyncFile[];
    roots: string[];
}

function normalisePath(value: string): string | null {
    const path = value.normalize('NFC').replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
    if (!path.startsWith('/') && !/^[a-z]:(\/|$)/.test(path)) return null;
    const segments = path.startsWith('/') ? path.slice(1).split('/') : path.split('/');
    if (segments.some((part) => part === '.' || part === '..' || part === '')) return null;
    return path;
}

/** Strip only a configured enclosing root, on a directory boundary. */
export function relativeSyncPath(path: string, roots: readonly string[]): string | null {
    const normalised = normalisePath(path);
    if (!normalised) return null;
    const matches = roots
        .map((root) => (root === '/' ? '' : normalisePath(root)))
        .filter((root): root is string => root !== null && normalised.startsWith(root + '/'))
        .sort((a, b) => b.length - a.length);
    return matches.length > 0 ? normalised.slice(matches[0].length + 1) || null : null;
}

function sizeKey(size: SyncFile['size']): string | null {
    if (size == null) return null;
    if (typeof size === 'number' && (!Number.isSafeInteger(size) || size < 0)) return null;
    return /^\d+$/.test(String(size)) ? BigInt(size).toString() : null;
}

/**
 * Index keys for one file: the root-relative path, plus the full path. The full
 * path is the same physical file even when the two systems configure different
 * library roots (`/data` vs `/data/movies`), where relative paths would differ.
 */
function pathKeys(mediaType: string, file: SyncFile, roots: readonly string[]): string[] {
    const keys: string[] = [];
    const relative = relativeSyncPath(file.path, roots);
    if (relative) keys.push(`${mediaType}:${relative}`);
    const absolute = normalisePath(file.path);
    if (absolute) keys.push(`${mediaType}:abs:${absolute}`);
    return keys;
}

/**
 * A file that holds several episodes (`S01E03-E04`) is ONE path for several
 * items, on Lumastra's side (one episode row each) and on Jellyfin's (one item per
 * episode, or a single item spanning the range). The path alone cannot say which
 * pairs with which, so tell them apart by episode number: a Jellyfin item pairs
 * with the Lumastra episode that has its (first) number, and an item that spans a
 * range pairs with the first episode of it, whose watched mark the pull then
 * extends over the rest of the file. Only unambiguous pairs get their paths
 * tagged; everything else keeps the plain shared path and stays unpaired.
 */
function separateSharedEpisodes(
    remote: readonly SyncFileItem[],
    local: readonly SyncFileItem[],
): { remote: readonly SyncFileItem[]; local: readonly SyncFileItem[] } {
    const numbered = (item: SyncFileItem) =>
        item.mediaType === 'episode' && item.episode != null && item.season != null;
    const sharedLocal = local.filter((item) => item.pairable === false && numbered(item));
    if (sharedLocal.length === 0) return { remote, local };
    const keysOf = (item: SyncFileItem): string[] =>
        item.files.flatMap((file) => pathKeys(item.mediaType, file, file.roots ?? item.roots));
    const index = (items: readonly SyncFileItem[]) => {
        const byKey = new Map<string, Set<SyncFileItem>>();
        for (const item of items)
            for (const key of keysOf(item)) byKey.set(key, (byKey.get(key) ?? new Set()).add(item));
        return byKey;
    };
    const remoteByKey = index(remote);
    const localByKey = index(local);
    const sharing = (item: SyncFileItem, byKey: Map<string, Set<SyncFileItem>>) => {
        const found = new Set<SyncFileItem>();
        for (const key of keysOf(item)) for (const other of byKey.get(key) ?? []) found.add(other);
        found.delete(item);
        return found;
    };
    const sharedLocalSet = new Set(sharedLocal);

    // Tentative pairs: the Jellyfin item and the one Lumastra episode of its number.
    const pairs = new Map<SyncFileItem, SyncFileItem>();
    for (const item of remote) {
        if (!numbered(item)) continue;
        const matches = [...sharing(item, localByKey)]
            .filter((c) => sharedLocalSet.has(c))
            .filter((c) => c.season === item.season && c.episode === item.episode);
        const unique = [...new Set(matches)];
        if (unique.length !== 1) continue;
        const [candidate] = unique;
        // An item that spans a range belongs to the file's FIRST episode: the pull
        // extends its watched mark forward only. If Jellyfin numbers the file
        // differently from Lumastra, leave it alone rather than pair a later episode.
        if (item.episodeEnd != null && item.episodeEnd > item.episode!) {
            const first = Math.min(
                candidate.episode!,
                ...[...sharing(candidate, localByKey)]
                    .filter((c) => sharedLocalSet.has(c) && c.season === candidate.season)
                    .map((c) => c.episode!),
            );
            if (candidate.episode !== first) continue;
        }
        pairs.set(item, candidate);
    }
    // Two Jellyfin items for one Lumastra episode, or anything else on the same
    // path that is not part of a pair (another Jellyfin item, a plain local row), is
    // ambiguity as before: drop the pair, and repeat since that can strand others.
    for (let changed = true; changed;) {
        changed = false;
        const claimed = new Map<SyncFileItem, number>();
        for (const l of pairs.values()) claimed.set(l, (claimed.get(l) ?? 0) + 1);
        for (const [r, l] of [...pairs]) {
            const strayRemote = [...sharing(r, remoteByKey)].some((o) => !pairs.has(o));
            const strayLocal = [...sharing(l, localByKey)].some((o) => !sharedLocalSet.has(o));
            if (strayRemote || strayLocal || claimed.get(l)! > 1) {
                pairs.delete(r);
                changed = true;
            }
        }
    }
    const tag = (item: SyncFileItem): SyncFileItem => ({
        ...item,
        pairable: true,
        files: item.files.map((file) => ({
            ...file,
            path: `${file.path}#s${item.season}e${item.episode}`,
        })),
    });
    const taggedLocal = new Set(pairs.values());
    return {
        remote: remote.map((item) => (pairs.has(item) ? tag(item) : item)),
        local: local.map((item) => (taggedLocal.has(item) ? tag(item) : item)),
    };
}

/**
 * Global bipartite uniqueness: one candidate on EACH side, across all roots,
 * paths and media sources. Case/NFC collisions are ambiguity, never a tie-break.
 * Multi-episode files participate in ambiguity detection but cannot be paired.
 */
export function matchSyncFiles(
    remoteItems: readonly SyncFileItem[],
    localItems: readonly SyncFileItem[],
): Map<string, string> {
    const { remote, local } = separateSharedEpisodes(remoteItems, localItems);
    const index = new Map<string, Array<{ id: string; size: string | null }>>();
    for (const item of local) {
        for (const file of item.files) {
            for (const key of pathKeys(item.mediaType, file, file.roots ?? item.roots)) {
                const entries = index.get(key) ?? [];
                entries.push({ id: item.id, size: sizeKey(file.size) });
                index.set(key, entries);
            }
        }
    }
    // Item-pair evidence, judged per path-matched file pair: `knownPairs` holds item
    // pairs with at least one file pair that matched by path AND has equal known
    // sizes; `blockedPairs` holds item pairs with any path-matched file pair whose
    // sizes differ or are unknown. A pair is accepted only when it is known and
    // never blocked, so an equal-size file of the same items cannot vouch for a
    // path-matched file that disagrees.
    const knownPairs = new Set<string>();
    const blockedPairs = new Set<string>();
    const candidates = new Map<string, Set<string>>();
    const reverse = new Map<string, Set<string>>();
    for (const item of remote) {
        const ids = candidates.get(item.id) ?? new Set<string>();
        for (const file of item.files) {
            const size = sizeKey(file.size);
            const entries = pathKeys(item.mediaType, file, file.roots ?? item.roots).flatMap(
                (key) => index.get(key) ?? [],
            );
            for (const entry of entries) {
                const pair = `${item.id}:${entry.id}`;
                const known = size !== null && entry.size !== null;
                if (known && size !== entry.size) {
                    blockedPairs.add(pair);
                    continue;
                }
                if (known) knownPairs.add(pair);
                else blockedPairs.add(pair);
                ids.add(entry.id);
                const owners = reverse.get(entry.id) ?? new Set<string>();
                owners.add(item.id);
                reverse.set(entry.id, owners);
            }
        }
        candidates.set(item.id, ids);
    }
    const blockedRemote = new Set(
        remote.filter((item) => item.pairable === false).map((item) => item.id),
    );
    const blockedLocal = new Set(
        local.filter((item) => item.pairable === false).map((item) => item.id),
    );
    const localById = new Map(local.map((item) => [item.id, item]));
    const remoteById = new Map(remote.map((item) => [item.id, item]));
    const matches = new Map<string, string>();
    for (const [id, ids] of candidates) {
        if (ids.size !== 1 || blockedRemote.has(id)) continue;
        const [localId] = ids;
        if (
            !blockedLocal.has(localId) &&
            reverse.get(localId)?.size === 1 &&
            !hasConflictingProviderIds(remoteById.get(id)!, localById.get(localId)!) &&
            knownPairs.has(`${id}:${localId}`) &&
            !blockedPairs.has(`${id}:${localId}`)
        )
            matches.set(id, localId);
    }
    return matches;
}

export function hasConflictingProviderIds(a: SyncFileItem, b: SyncFileItem): boolean {
    return (['tmdb', 'imdb'] as const).some((provider) => {
        const left = a.providerIds?.[provider]?.toLowerCase();
        const right = b.providerIds?.[provider]?.toLowerCase();
        return Boolean(left && right && left !== right);
    });
}

/** Library presence, independent of size and ambiguity; linear in inventory size. */
export function getSyncPathCandidates(
    remote: readonly SyncFileItem[],
    local: readonly SyncFileItem[],
): Map<string, Set<string>> {
    const paths = new Map<string, Set<string>>();
    for (const item of local)
        for (const file of item.files) {
            for (const key of pathKeys(item.mediaType, file, file.roots ?? item.roots)) {
                const ids = paths.get(key) ?? new Set<string>();
                ids.add(item.id);
                paths.set(key, ids);
            }
        }
    const result = new Map<string, Set<string>>();
    for (const item of remote)
        for (const file of item.files) {
            const keys = pathKeys(item.mediaType, file, file.roots ?? item.roots);
            for (const id of keys.flatMap((key) => [...(paths.get(key) ?? [])])) {
                const ids = result.get(item.id) ?? new Set<string>();
                ids.add(id);
                result.set(item.id, ids);
            }
        }
    return result;
}
