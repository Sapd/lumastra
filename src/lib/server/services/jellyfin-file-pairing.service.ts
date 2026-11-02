// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { getJellyfinFileDetails, getJellyfinFileInventory } from '../jellyfin/file-inventory.js';
import {
    getLocalSyncFiles,
    getLocalSyncSignature,
    getJellyfinPairings,
    requeueNewJellyfinPairing,
    getSyncProviderIdentities,
    getFileInventoryState,
    needsFileInventory,
    lockFilePairing,
    claimFileInventory,
    saveFileInventory,
    saveFileInventoryItems,
    savePairingCandidates,
    type PairingCandidate,
} from '../database/queries/jellyfin-file-pairing.queries.js';
import {
    matchSyncFiles,
    getSyncPathCandidates,
    hasConflictingProviderIds,
    type SyncFileItem,
} from './jellyfin-file-matcher.js';
import { createCatalogService } from './catalog.service.js';
import { withTx } from '../database/with-tx.js';

import { getJellyfinPairingScopes } from './jellyfin-pairing-status.service.js';
import { Logger } from '../utils/logger.js';
const logger = Logger.for('JellyfinFilePairing');

const SOURCE = 'watch-sync-file';

/** Most items whose sizes one cycle looks up; the rest follow on the next cycles. */
const SIZE_LOOKUP_LIMIT = 500;

/**
 * The local file fingerprint a cached-listing comparison last ran against, so an
 * id-less file Jellyfin does not have is compared once per local change, not every
 * five minutes. Per process: a restart only repeats one cheap comparison.
 */
let lastRecomparedSignature: string | null = null;
/** Same, for the size lookup of cached items. */
let lastSizeLookupSignature: string | null = null;

export interface FilePairingRefreshResult {
    firstInventory: boolean;
    changedPairings: boolean;
}

/** Short, bounded compare/write transactions; all Jellyfin HTTP stays outside them. */
export async function refreshJellyfinFilePairings(
    sql: postgres.Sql,
    signal?: AbortSignal,
    rawIncomingIds: readonly string[] = [],
    options: { fetch: boolean } = { fetch: true },
): Promise<FilePairingRefreshResult> {
    const unchanged = { firstInventory: false, changedPairings: false };
    const incomingIds = rawIncomingIds.map((id) =>
        /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)
            ? id.replaceAll('-', '').toLowerCase()
            : id,
    );
    try {
        const eligible = await getJellyfinPairingScopes(sql, signal);
        const discover = eligible.push.length + eligible.pull.length > 0;
        const need = await needsFileInventory(
            sql,
            eligible.push,
            incomingIds,
            eligible.pull,
            discover,
        );
        if (!need.needed && !(need.recompare && need.signature !== lastRecomparedSignature))
            return unchanged;
        const generation = randomUUID();
        const claimed =
            options.fetch &&
            need.needed &&
            (await withTx(sql, async (rawTx) => {
                const tx = rawTx as unknown as postgres.Sql;
                await lockFilePairing(tx);
                const state = await getFileInventoryState(tx, false);
                if (state && !state.due) return false;
                await claimFileInventory(tx, generation);
                return true;
            }));
        let fetched: SyncFileItem[] | undefined;
        const localSignature = claimed ? await getLocalSyncSignature(sql) : null;
        if (claimed) {
            const local = buildLocalFiles(await getLocalSyncFiles(sql));
            const links = await getJellyfinPairings(sql);
            fetched = await getJellyfinFileInventory(
                signal,
                [...local.values()],
                links.filter((link) => link.source === SOURCE).map((link) => link.external_id),
            );
        }
        // A cached listing carries no sizes for files that were not local when it was
        // taken (the fresh install scans its series while the first inventory runs).
        // Look those up now instead of waiting for the next throttled listing.
        const lookup =
            fetched === undefined && options.fetch
                ? await lookUpMissingSizes(sql, need.signature, signal)
                : { sizes: null, complete: true };
        const sizes = lookup.sizes;
        return await withTx(sql, async (rawTx) => {
            const tx = rawTx as unknown as postgres.Sql;
            await lockFilePairing(tx);
            const state = await getFileInventoryState(tx);
            // An expired worker must never overwrite evidence from a newer claimant.
            if (!state || (claimed && state.generation !== generation)) return unchanged;
            const fresh = fetched !== undefined;
            if (!fresh && !state.usable) return unchanged;
            let changedPairings = false;
            const missing = new Set(state.missing_ids);
            if (!fresh && sizes && sizes.size > 0) {
                // Only for a cached file the lookup names by the same path: a newer
                // listing that moved the file must not receive the old file's sizes.
                state.inventory = state.inventory.map((item) => {
                    const details = sizes.get(item.id);
                    return details && item.files.some((f) => details.some((d) => d.path === f.path))
                        ? { ...item, files: details }
                        : item;
                });
                await saveFileInventoryItems(tx, state.inventory);
            }
            const remote = fetched ?? state.inventory.filter((item) => !missing.has(item.id));
            const local = buildLocalFiles(await getLocalSyncFiles(tx));
            // A shared public-provider id is stronger evidence, even when it
            // points to a catalog item whose physical path differs. Leave that
            // resolution to the existing id resolver; never pre-fill a conflicting
            // file cache that the live pull would resolve differently.
            const identities = await getSyncProviderIdentities(tx);
            const identityOwners = new Map<string, Set<string>>();
            for (const identity of identities) {
                const key = `${identity.provider}:${identity.external_id.toLowerCase()}:${identity.media_type}`;
                const owners = identityOwners.get(key) ?? new Set<string>();
                owners.add(identity.media_id);
                identityOwners.set(key, owners);
            }
            const stored = await getJellyfinPairings(tx);
            const existingFileTargets = new Map(
                stored
                    .filter((link) => link.source === SOURCE)
                    .map((link) => [link.external_id, link.media_id]),
            );
            const reaffirmedFileLinks = new Set<string>();
            const sharedRemoteIds = new Set<string>();
            const sharedLocalIds = new Set<string>();
            const remoteIdentityCounts = new Map<string, number>();
            for (const item of remote)
                for (const provider of ['tmdb', 'imdb'] as const) {
                    const id = item.providerIds?.[provider];
                    if (!id) continue;
                    const key = `${provider}:${id.toLowerCase()}:${item.mediaType}`;
                    remoteIdentityCounts.set(key, (remoteIdentityCounts.get(key) ?? 0) + 1);
                }
            for (const item of remote) {
                const existingTarget = existingFileTargets.get(item.id);
                let agreesWithExisting = existingTarget !== undefined;
                for (const provider of ['tmdb', 'imdb'] as const) {
                    const id = item.providerIds?.[provider];
                    if (!id) continue;
                    const owners = identityOwners.get(
                        `${provider}:${id.toLowerCase()}:${item.mediaType}`,
                    );
                    if (!owners) continue;
                    sharedRemoteIds.add(item.id);
                    if (!existingTarget || owners.size !== 1 || !owners.has(existingTarget))
                        agreesWithExisting = false;
                    for (const owner of owners) sharedLocalIds.add(owner);
                }
                if (sharedRemoteIds.has(item.id) && agreesWithExisting)
                    reaffirmedFileLinks.add(item.id);
            }
            for (const identity of identities) {
                const item = local.get(identity.media_id);
                if (item) {
                    item.providerIds ??= {};
                    item.providerIds[identity.provider] = identity.external_id;
                }
            }
            const candidates: PairingCandidate[] = [];
            const remoteById = new Map(remote.map((item) => [item.id, item]));
            for (const [remoteId, ids] of getSyncPathCandidates(remote, [...local.values()])) {
                for (const id of ids)
                    candidates.push({
                        remote_id: remoteId,
                        media_id: id,
                        title: local.get(id)!.title ?? remoteById.get(remoteId)!.title ?? remoteId,
                        conflict: hasConflictingProviderIds(
                            remoteById.get(remoteId)!,
                            local.get(id)!,
                        ),
                    });
            }
            const matches = matchSyncFiles(remote, [...local.values()]);
            for (const [remoteId, localId] of matches) {
                if (sharedRemoteIds.has(remoteId) || sharedLocalIds.has(localId)) {
                    // Metadata arriving later must not tear down a still-valid file
                    // link before a resume-only push can use it. Keep it only when
                    // every shared identity agrees AND the current file still matches.
                    const item = remoteById.get(remoteId)!;
                    const keys = (['tmdb', 'imdb'] as const).flatMap((provider) => {
                        const id = item.providerIds?.[provider];
                        return id ? [`${provider}:${id.toLowerCase()}:${item.mediaType}`] : [];
                    });
                    // An ID resolver deliberately refuses multiple remote versions.
                    // A unique known-size file match may distinguish them, provided
                    // every shared identity still has exactly this catalog owner.
                    const disambiguatedVersion =
                        sharedRemoteIds.has(remoteId) &&
                        keys.some((key) => (remoteIdentityCounts.get(key) ?? 0) > 1) &&
                        keys.every((key) => {
                            const owners = identityOwners.get(key);
                            return !owners || (owners.size === 1 && owners.has(localId));
                        });
                    if (
                        (!reaffirmedFileLinks.has(remoteId) ||
                            existingFileTargets.get(remoteId) !== localId) &&
                        !disambiguatedVersion
                    )
                        matches.delete(remoteId);
                }
            }
            const previousMatches = stored.some(
                (link) => link.source === SOURCE && !remoteById.has(link.external_id),
            )
                ? matchSyncFiles(state.inventory, [...local.values()])
                : new Map<string, string>();
            const missingIds: string[] = [];
            const missingLocalIds = stored
                .filter((link) => link.source === SOURCE && !local.has(link.media_id))
                .map((link) => link.external_id);
            const preserved = new Set<string>();
            for (const link of stored) {
                if (link.source !== SOURCE || remoteById.has(link.external_id)) continue;
                if (fresh) missingIds.push(link.external_id);
                // Only fresh complete snapshots advance the absence confirmation.
                if (
                    previousMatches.get(link.external_id) === link.media_id &&
                    (!fresh || !state.missing_ids.includes(link.external_id))
                )
                    preserved.add(link.external_id);
            }
            // A missing mount / disabled path is weak evidence, unlike a
            // present file whose path or size changed. Confirm absence twice.
            for (const link of stored) {
                if (link.source !== SOURCE || local.has(link.media_id)) continue;
                if (!fresh || !state.missing_local_ids.includes(link.external_id))
                    preserved.add(link.external_id);
            }
            const catalog = createCatalogService(tx, { skipLifecycleHooks: true });
            for (const link of stored) {
                if (
                    link.source === SOURCE &&
                    !preserved.has(link.external_id) &&
                    matches.get(link.external_id) !== link.media_id
                ) {
                    const deleted = await catalog.deleteExternalId(
                        link.media_id,
                        'jellyfin',
                        link.media_type,
                    );
                    changedPairings = changedPairings || deleted > 0;
                }
            }
            // ID-based mappings retain priority. Never replace an existing mapping
            // with file evidence, nor attach a second remote item to the same media.
            const reserved = stored.filter(
                (link) =>
                    link.source !== SOURCE ||
                    preserved.has(link.external_id) ||
                    matches.get(link.external_id) === link.media_id,
            );
            const remoteReserved = new Set(reserved.map((link) => link.external_id));
            const localReserved = new Set(reserved.map((link) => link.media_id));
            for (const [remoteId, mediaId] of matches) {
                signal?.throwIfAborted();
                if (remoteReserved.has(remoteId) || localReserved.has(mediaId)) continue;
                const mediaType = local.get(mediaId)!.mediaType as 'movie' | 'episode';
                const { written, changed } = await catalog.upsertExternalIdDetailed(mediaId, {
                    provider: 'jellyfin',
                    id: remoteId,
                    mediaType,
                    source: SOURCE,
                });
                if (!written) throw new Error('Jellyfin file pairing could not be saved');
                changedPairings = changedPairings || changed;
                await requeueNewJellyfinPairing(tx, mediaId);
            }
            await savePairingCandidates(tx, candidates);
            if (fresh)
                await saveFileInventory(
                    tx,
                    [
                        ...remote,
                        // Retain last evidence solely to validate local files during absence grace.
                        // missing_ids excludes these entries from new matching / library presence.
                        ...state.inventory.filter(
                            (item) => preserved.has(item.id) && !remoteById.has(item.id),
                        ),
                    ],
                    missingIds,
                    missingLocalIds,
                    localSignature!,
                );
            // Remembered only once nothing is left to look up; a truncated or failed
            // lookup must be picked up again next cycle.
            if (!fresh && lookup.complete) lastRecomparedSignature = need.signature;
            return { firstInventory: fresh && state.refreshed_at === null, changedPairings };
        });
    } catch (error) {
        signal?.throwIfAborted();
        logger.warn('File inventory unavailable; keeping links and continuing ID-based sync', {
            error: String(error),
        });
        return unchanged;
    }
}

/**
 * Sizes for cached remote items that match a local path but have none yet. Reads
 * the cache and the local files outside the pairing lock; a failed lookup only
 * leaves those items unpaired until the next listing.
 */
async function lookUpMissingSizes(
    sql: postgres.Sql,
    signature: string,
    signal?: AbortSignal,
): Promise<{ sizes: Map<string, SyncFileItem['files']> | null; complete: boolean }> {
    // Only a local change since the cached listing can introduce a file whose
    // candidates were not looked up; check that once per such change.
    if (signature === lastSizeLookupSignature) return { sizes: null, complete: true };
    try {
        const head = await getFileInventoryState(sql, false);
        if (!head?.usable) return { sizes: null, complete: false };
        if (head.local_signature === signature) {
            lastSizeLookupSignature = signature;
            return { sizes: null, complete: true };
        }
        const state = await getFileInventoryState(sql);
        if (!state) return { sizes: null, complete: false };
        const missing = new Set(state.missing_ids);
        const remote = state.inventory.filter((item) => !missing.has(item.id));
        const byId = new Map(remote.map((item) => [item.id, item]));
        const local = [...buildLocalFiles(await getLocalSyncFiles(sql)).values()];
        const wanted = [...getSyncPathCandidates(remote, local).keys()].filter((id) =>
            byId.get(id)?.files.some((file) => file.size == null),
        );
        const found =
            wanted.length === 0
                ? null
                : await getJellyfinFileDetails(
                      wanted.slice(0, SIZE_LOOKUP_LIMIT),
                      new Map(remote.map((item) => [item.id, item.roots])),
                      signal,
                  );
        const complete = wanted.length <= SIZE_LOOKUP_LIMIT;
        if (complete) lastSizeLookupSignature = signature;
        return { sizes: found, complete };
    } catch (error) {
        signal?.throwIfAborted();
        logger.warn('Jellyfin file size lookup failed; pairing waits for the next inventory', {
            error: String(error),
        });
        return { sizes: null, complete: false };
    }
}

function buildLocalFiles(
    rows: Awaited<ReturnType<typeof getLocalSyncFiles>>,
): Map<string, SyncFileItem> {
    const local = new Map<string, SyncFileItem>();
    const excluded = new Set(rows.filter((row) => row.combined).map((row) => row.id));
    for (const row of rows) {
        const item = local.get(row.id) ?? {
            id: row.id,
            mediaType: row.media_type,
            title: row.title,
            pairable: !excluded.has(row.id),
            ...(row.media_type === 'episode'
                ? { season: row.season_number, episode: row.episode_number, episodeEnd: null }
                : {}),
            roots: [],
            files: [],
        };
        item.roots.push(row.root);
        const file = item.files.find((entry) => entry.path === row.file_path);
        if (file) file.roots?.push(row.root);
        else
            item.files.push({
                path: row.file_path,
                size: row.file_size_bytes,
                roots: [row.root],
            });
        local.set(row.id, item);
    }
    return local;
}
