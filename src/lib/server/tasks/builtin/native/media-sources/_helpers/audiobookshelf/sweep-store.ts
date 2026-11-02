// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Database port for the Audiobookshelf reconcile sweep.
 *
 * Binds the {@link AudiobookSweepStore} interface to the real query module,
 * `CatalogService` and the cache-invalidation service. Kept separate from
 * `sweep.ts` so the executor stays unit-testable against a fake store.
 */

import type postgres from 'postgres';
import { cleanupAudiobookCatalog } from '$lib/server/database/queries/audiobook-catalog-maintenance.queries.js';
import { CatalogService } from '$lib/server/services/catalog.service.js';
import { withTx } from '$lib/server/database/with-tx.js';
import { findMediaIdByExternalId } from '$lib/server/database/queries/catalog-operations.queries.js';
import {
    AUDIOBOOKSHELF_PROVIDER,
    AUDIOBOOK_MEDIA_TYPE,
    insertAudiobook,
    listAudiobooksForAbsLibrary,
    setAudiobookFlags,
    updateAudiobookFromRemote,
    type AudiobookFlagUpdate,
    type AudiobookWriteParams,
    type LocalAudiobookRow,
} from '$lib/server/database/queries/audiobooks.queries.js';
import type { AudiobookSweepStore } from './sweep.js';

/**
 * Ids per cache-invalidation call. `onContentAdded` logs the id list, and the
 * first sweep of a large library would otherwise emit one log line holding
 * thousands of UUIDs. The service coalesces the cascade regardless, so
 * chunking costs nothing.
 */
const INVALIDATION_CHUNK = 200;

/**
 * Advisory-lock namespace for the check-then-insert. Distinct from the
 * `movie-scan:*` / `series:*` / bare-uuid keys used elsewhere, so an ABS item
 * can never contend with an unrelated subsystem's lock.
 */
function insertLockKey(absItemId: string): string {
    return `abs-item:${absItemId}`;
}

export function createAudiobookSweepStore(sql: postgres.Sql): AudiobookSweepStore {
    return {
        async listLocal(absLibraryId: string): Promise<LocalAudiobookRow[]> {
            return listAudiobooksForAbsLibrary(sql, absLibraryId);
        },

        async insert(absItemId: string, params: AudiobookWriteParams): Promise<string> {
            return withTx(sql, async (txRaw) => {
                const tx = txRaw as unknown as postgres.Sql;

                // `external_ids` uniqueness is enforced with ON CONFLICT DO
                // UPDATE, which does NOT raise on a concurrent duplicate — it
                // silently re-points the mapping at the second row and orphans
                // the first (no external id ⇒ invisible to `listLocal` ⇒ never
                // reconciled again). Serialise the whole check-then-insert per
                // ABS item id so two sweeps — in this process or on two
                // replicas — cannot both decide the book is new.
                // Bound the wait so a wedged holder cannot pin this pooled
                // connection for the whole run; on timeout the transaction
                // errors out, the sweep records one `unmatched` item, and the
                // next cycle retries it. Literal because `SET LOCAL` takes no
                // bind parameters.
                await tx`SET LOCAL lock_timeout = '30s'`;
                await tx`SELECT pg_advisory_xact_lock(hashtext(${insertLockKey(absItemId)}))`;

                // The id may already be ours even though this library's diff
                // called it new: `listLocal` partitions by
                // `custom_metadata.audiobookshelf.libraryId`, while
                // `external_ids` is unique install-wide. An item moved between
                // ABS libraries therefore looks absent-locally to its new
                // library. Updating (rather than inserting) re-stamps the
                // owning `libraryId` and clears the dismissal the old library
                // may have applied, in one write — where a blind insert would
                // throw on the composite key every 15 minutes forever.
                const existing = await findMediaIdByExternalId(tx, {
                    provider: AUDIOBOOKSHELF_PROVIDER,
                    externalId: absItemId,
                    mediaType: AUDIOBOOK_MEDIA_TYPE,
                });
                if (existing) {
                    await updateAudiobookFromRemote(tx, existing, params);
                    return existing;
                }

                const mediaId = await insertAudiobook(tx, params);
                // `skipLifecycleHooks` because the hook must not fire from
                // inside the transaction that created the row — it would race
                // readers against an uncommitted id. The sweep invalidates
                // caches once per run instead.
                const catalog = new CatalogService(tx, { skipLifecycleHooks: true });
                await catalog.upsertExternalId(
                    mediaId,
                    {
                        provider: AUDIOBOOKSHELF_PROVIDER,
                        id: absItemId,
                        mediaType: AUDIOBOOK_MEDIA_TYPE,
                        source: AUDIOBOOKSHELF_PROVIDER,
                    },
                    true,
                );
                return mediaId;
            });
        },

        update(mediaId: string, params: AudiobookWriteParams): Promise<void> {
            return updateAudiobookFromRemote(sql, mediaId, params);
        },

        setFlags(mediaIds: string[], flags: AudiobookFlagUpdate): Promise<number> {
            return setAudiobookFlags(sql, mediaIds, { ...flags, requireConfiguredLibrary: true });
        },

        async onContentChanged(mediaIds: string[]): Promise<void> {
            await cleanupAudiobookCatalog(sql);
            if (mediaIds.length === 0) return;
            const { cacheInvalidation } = await import('$lib/server/cache');
            for (let i = 0; i < mediaIds.length; i += INVALIDATION_CHUNK) {
                await cacheInvalidation.onContentAdded(mediaIds.slice(i, i + INVALIDATION_CHUNK));
            }
        },
    };
}
