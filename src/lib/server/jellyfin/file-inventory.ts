// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { jellyfinUserService } from './user.service.js';
import { buildJellyfinAuthHeaders } from './auth-headers.js';
import { isEpisode } from '../utils/media-types.js';
import { withJellyfinRetry } from './retry.js';
import {
    getSyncPathCandidates,
    type SyncFile,
    type SyncFileItem,
} from '../services/jellyfin-file-matcher.js';

interface InventoryItem {
    Id: string;
    Name?: string;
    Type?: string;
    ProviderIds?: { Tmdb?: string; Imdb?: string };
    Path?: string;
    Size?: number;
    MediaSourceCount?: number;
    MediaSources?: Array<{ Path?: string; Size?: number }>;
    ParentIndexNumber?: number;
    IndexNumber?: number;
    IndexNumberEnd?: number;
}

class InventoryDriftError extends Error {}

/** Retry one entire snapshot if a scan changes page membership or details mid-fetch. */
export async function getJellyfinFileInventory(
    signal?: AbortSignal,
    local: readonly SyncFileItem[] = [],
    storedIds: readonly string[] = [],
): Promise<SyncFileItem[]> {
    let uniqueSort = true;
    for (let attempt = 0; ; attempt++) {
        try {
            return await getInventorySnapshot(signal, local, storedIds, uniqueSort);
        } catch (error) {
            // ItemSortBy.Id is not available on older Jellyfin versions. Keep
            // full drift detection/retry there rather than rejecting inventory.
            if (
                uniqueSort &&
                (error as { response?: { status?: number } }).response?.status === 400
            ) {
                uniqueSort = false;
                attempt--;
                continue;
            }
            if (!(error instanceof InventoryDriftError) || attempt >= 1) throw error;
            signal?.throwIfAborted();
        }
    }
}

/** Complete inventory, not just played items: uniqueness must include unwatched duplicates. */
async function getInventorySnapshot(
    signal: AbortSignal | undefined,
    local: readonly SyncFileItem[],
    storedIds: readonly string[],
    uniqueSort: boolean,
): Promise<SyncFileItem[]> {
    const client = jellyfinUserService.getAxiosInstance();
    const base = jellyfinUserService.getBaseUrl();
    const token = jellyfinUserService.getApiToken();
    if (!client || !base || !token)
        throw new Error('Jellyfin client not available for file pairing');
    const options = { signal, headers: buildJellyfinAuthHeaders({ token }) };
    const folders = await withJellyfinRetry(
        () =>
            client.get<Array<{ ItemId?: string; Locations?: string[] }>>(
                `${base}/Library/VirtualFolders`,
                options,
            ),
        { signal },
    );
    if (!Array.isArray(folders.data)) throw new Error('Jellyfin library roots response is invalid');
    if (folders.data.some((folder) => (folder.Locations?.length ?? 0) > 0 && !folder.ItemId))
        throw new Error('Jellyfin library is missing its ID');
    const libraries = folders.data.filter((folder) => (folder.Locations?.length ?? 0) > 0);
    const result = new Map<string, SyncFileItem>();
    const multiSource = new Set<string>();
    const limit = 500;
    for (const library of libraries) {
        const roots = library.Locations ?? [];
        const librarySeen = new Set<string>();
        let expectedTotal: number | undefined;
        for (let startIndex = 0; ; startIndex += limit) {
            signal?.throwIfAborted();
            const response = await withJellyfinRetry(
                () =>
                    client.get<{ Items?: InventoryItem[]; TotalRecordCount?: number }>(
                        `${base}/Items`,
                        {
                            ...options,
                            params: {
                                ParentId: library.ItemId,
                                IncludeItemTypes: 'Movie,Episode,Video',
                                Recursive: true,
                                Fields: 'Path,ProviderIds,MediaSourceCount,ParentIndexNumber,IndexNumber,IndexNumberEnd',
                                EnableTotalRecordCount: true,
                                EnableImages: false,
                                EnableUserData: false,
                                StartIndex: startIndex,
                                Limit: limit,
                                SortBy: uniqueSort
                                    ? 'SortName,DateCreated,Id'
                                    : 'SortName,DateCreated',
                                SortOrder: 'Ascending',
                            },
                        },
                    ),
                { signal },
            );
            const page = response.data.Items;
            if (!Array.isArray(page))
                throw new Error('Jellyfin file inventory response is invalid');
            const total = response.data.TotalRecordCount;
            if (total === undefined || !Number.isSafeInteger(total) || total < 0)
                throw new Error('Jellyfin inventory is missing its total count');
            if (expectedTotal !== undefined && expectedTotal !== total)
                throw new InventoryDriftError(
                    'Jellyfin inventory changed during file pairing; retry required',
                );
            expectedTotal = total;
            for (const item of page) {
                if (librarySeen.has(item.Id))
                    throw new InventoryDriftError(
                        'Jellyfin inventory changed during file pairing; retry required',
                    );
                librarySeen.add(item.Id);
                // Combined files have multiple watch targets. Leave them unmatched
                // until a file-based pairing can express their episode windows.
                const pairable =
                    item.IndexNumberEnd == null || item.IndexNumberEnd === item.IndexNumber;
                const files = (item.MediaSources ?? []).flatMap((source) =>
                    source.Path
                        ? [
                              {
                                  path: source.Path,
                                  size:
                                      source.Size ??
                                      (source.Path === item.Path ? item.Size : undefined),
                              },
                          ]
                        : [],
                );
                if (item.Path && !files.some((file) => file.path === item.Path))
                    files.push({ path: item.Path, size: item.Size });
                const id = item.Id.replaceAll('-', '').toLowerCase();
                if ((item.MediaSourceCount ?? 0) > 1) multiSource.add(id);
                const prior = result.get(id);
                if (prior) {
                    prior.pairable = prior.pairable !== false && pairable;
                    prior.roots.push(...roots);
                    prior.files.push(...files.map((file) => ({ ...file, roots: [...roots] })));
                } else
                    result.set(id, {
                        pairable,
                        id,
                        title: item.Name,
                        providerIds: { tmdb: item.ProviderIds?.Tmdb, imdb: item.ProviderIds?.Imdb },
                        mediaType: isEpisode(item.Type) ? 'episode' : 'movie',
                        ...(isEpisode(item.Type)
                            ? {
                                  season: item.ParentIndexNumber ?? null,
                                  episode: item.IndexNumber ?? null,
                                  episodeEnd: item.IndexNumberEnd ?? null,
                              }
                            : {}),
                        roots: [...roots],
                        files: files.map((file) => ({ ...file, roots: [...roots] })),
                    });
            }
            if (startIndex + page.length === total) break;
            if (startIndex + page.length > total || page.length === 0 || page.length < limit)
                throw new InventoryDriftError('Incomplete Jellyfin inventory; retry required');
        }
    }
    // BaseItemDto has no Size field. Jellyfin does not offer a nested field mask
    // for MediaSources (and includes stream metadata in each source). Fetch that
    // heavier DTO only for path candidates / existing links, never every item.
    const candidates = getSyncPathCandidates([...result.values()], local);
    const ids = [...new Set([...candidates.keys(), ...storedIds, ...multiSource])].filter((id) =>
        result.has(id),
    );
    for (let offset = 0; offset < ids.length; offset += 100) {
        const batch = ids.slice(offset, offset + 100);
        const response = await withJellyfinRetry(
            () =>
                client.get<{ Items?: InventoryItem[] }>(`${base}/Items`, {
                    ...options,
                    params: {
                        Ids: batch.join(','),
                        Fields: 'Path,MediaSources,ProviderIds',
                        EnableImages: false,
                        EnableUserData: false,
                    },
                }),
            { signal },
        );
        const items = response.data.Items;
        if (!Array.isArray(items)) throw new Error('Invalid Jellyfin file details');
        const seen = new Set<string>();
        for (const item of items) {
            const id = item.Id.replaceAll('-', '').toLowerCase();
            if (!batch.includes(id) || seen.has(id))
                throw new InventoryDriftError('Unstable Jellyfin file inventory details');
            seen.add(id);
            const entry = result.get(id)!;
            // A move between the cheap inventory and details is page drift too.
            if (!entry.files.some((file) => file.path === item.Path))
                throw new InventoryDriftError('Jellyfin file moved during inventory');
            entry.files = (item.MediaSources ?? []).flatMap((source) =>
                source.Path
                    ? [
                          {
                              path: source.Path,
                              size: source.Size,
                              roots: [...entry.roots],
                          },
                      ]
                    : [],
            );
            if (item.Path && !entry.files.some((file) => file.path === item.Path))
                entry.files.push({ path: item.Path, size: item.Size, roots: [...entry.roots] });
        }
        if (seen.size !== batch.length)
            throw new InventoryDriftError('Incomplete Jellyfin file inventory details');
    }
    return [...result.values()];
}

/**
 * Media sources (path and size) for specific items of an already cached
 * inventory. The listing carries no sizes, so a local file scanned after that
 * listing was taken has nothing to be matched against until its candidates are
 * looked up; this is that lookup, for a handful of ids and nothing else.
 *
 * Items Jellyfin no longer returns are omitted. Drift is not an error here:
 * these files only feed a comparison, and a moved file simply fails to match.
 */
export async function getJellyfinFileDetails(
    ids: readonly string[],
    roots: ReadonlyMap<string, readonly string[]>,
    signal?: AbortSignal,
): Promise<Map<string, SyncFile[]>> {
    const client = jellyfinUserService.getAxiosInstance();
    const base = jellyfinUserService.getBaseUrl();
    const token = jellyfinUserService.getApiToken();
    if (!client || !base || !token)
        throw new Error('Jellyfin client not available for file pairing');
    const result = new Map<string, SyncFile[]>();
    for (let offset = 0; offset < ids.length; offset += 100) {
        signal?.throwIfAborted();
        const batch = ids.slice(offset, offset + 100);
        const response = await withJellyfinRetry(
            () =>
                client.get<{ Items?: InventoryItem[] }>(`${base}/Items`, {
                    signal,
                    headers: buildJellyfinAuthHeaders({ token }),
                    params: {
                        Ids: batch.join(','),
                        Fields: 'Path,MediaSources,ProviderIds',
                        EnableImages: false,
                        EnableUserData: false,
                    },
                }),
            { signal },
        );
        const items = response.data.Items;
        if (!Array.isArray(items)) throw new Error('Invalid Jellyfin file details');
        for (const item of items) {
            const id = item.Id.replaceAll('-', '').toLowerCase();
            if (!batch.includes(id)) continue;
            const itemRoots = [...(roots.get(id) ?? [])];
            const files: SyncFile[] = (item.MediaSources ?? []).flatMap((source) =>
                source.Path ? [{ path: source.Path, size: source.Size, roots: itemRoots }] : [],
            );
            if (item.Path && !files.some((file) => file.path === item.Path))
                files.push({ path: item.Path, size: item.Size, roots: itemRoots });
            result.set(id, files);
        }
    }
    return result;
}
