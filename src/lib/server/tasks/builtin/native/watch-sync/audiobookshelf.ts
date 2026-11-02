// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * AudiobookShelf watch-sync connector.
 *
 * Moves listening position between Lumastra and an AudiobookShelf (ABS) server.
 * ABS is the source of truth; Lumastra keeps a local projection its own surfaces
 * (Weiterhören, social progress, the player's resume) can query in SQL.
 *
 * Shape is an ordinary `defineWatchSync` plugin — the same as Trakt and MAL, not
 * the Jellyfin exemption (whose dedicated 1321-line file is justified by
 * Jellyfin being the primary backend).
 *
 * ## Things here that are load-bearing and were verified, not assumed
 *
 * - **Pull reads complete user records**, either `GET /api/me` with a linked
 *   user's own key or operator-scoped `GET /api/users/:id` for a uniquely
 *   matched ABS-only listener. It never reads `/api/me/items-in-progress`
 *   (filters out finished rows, carries neither `currentTime` nor `isFinished`,
 *   defaults to `limit = 25`) or progress from the `GET /api/users` list —
 *   measured on the live server, that list returns `mediaProgress: []` for
 *   **all 26 accounts** while `GET /api/users/:id` returns 51/16/20 rows for
 *   the same users.
 * - **`listLinkedUsers` is implemented.** Returning `null` means "do not gate",
 *   and the push queue has no `media_type` filter — so on first enable the
 *   engine would drain every historical un-pushed event for every user across
 *   every media type into this provider at once.
 * - **Units.** ABS reports seconds for positions and epoch-milliseconds for
 *   timestamps. See `audiobookshelf-watch-sync.mapping.ts`.
 */

import {
    ABS_TIMESTAMP_TOLERANCE_MS,
    batchAudiobookProgressReader,
    readAudiobookProgress,
    readAudiobookResume,
} from '$lib/server/services/audiobook-resume.service.js';
import { toUserId } from '$lib/shared/user-id.js';
import { joinUpstreamUrl } from '$lib/shared/upstream-url.js';
import { defineWatchSync } from '@sapd/lumastra-plugin-sdk';
import type {
    PluginContext,
    ResumePositionItem,
    WatchSyncDefinition,
    WatchSyncPullOptions,
    WatchSyncPullResult,
    WatchSyncPushResult,
    WatchSyncResolveItem,
    WatchSyncResolvedId,
    WatchStateChange,
    WatchStatePullItem,
} from '@sapd/lumastra-plugin-sdk';
import { config } from '$lib/server/config.js';
import { fetchWithTimeout } from '$lib/server/utils/fetch-timeout.js';
import {
    audiobookshelfClient,
    AudiobookshelfUserAuthError,
    type AudiobookMe,
    type AudiobookSession,
} from '$lib/server/audiobookshelf.js';
import {
    forgetUserApiKey,
    resolveUserApiKey,
    type AbsCredentialDeps,
} from '$lib/server/services/audiobookshelf-credentials.service.js';
import {
    buildFrozenItemKeys,
    computeNextCursor,
    filterProgressByCursor,
    frozenKey,
    isCountableBookProgress,
    mapProgressToPullItem,
} from '$lib/server/services/audiobookshelf-watch-sync.mapping.js';
import { AUDIOBOOKSHELF_PROVIDER } from '$lib/server/database/queries/audiobooks.queries.js';
import { PluginSecrets } from '../../../secrets.js';
import { registerWatchSyncWithAutoTasks } from '../../index.js';
import { encodePathSegment } from '$lib/server/utils/upstream-path';
import {
    selectAudiobookshelfSyncUsers,
    type AudiobookshelfSyncUser,
} from '$lib/server/services/audiobookshelf-sync-users.js';
/** ABS calls the credential resolver needs, backed by the operator-level key. */
const credentialDeps: AbsCredentialDeps = {
    listUsers: () => audiobookshelfClient.listUsers(),
    createApiKey: (input) => audiobookshelfClient.createApiKey(input),
    deactivateApiKey: (id) => audiobookshelfClient.deactivateApiKey(id),
};

/**
 * Lumastra users that have an ABS key minted.
 *
 * Reads `plugin_user_credentials` directly rather than through `PluginSecrets`
 * because only the KEY SET is needed here, not the decrypted material — there is
 * no reason to decrypt (and audit-log) every user's token just to enumerate.
 */
async function loadLinkedUsers(ctx: PluginContext): Promise<AudiobookshelfSyncUser[]> {
    return (await selectAudiobookshelfSyncUsers(ctx.sql as never, { direction: 'push' })).users;
}

/**
 * Every active Lumastra user is eligible for an ABS pull. The connector still
 * requires an unambiguous same-name ABS account before fetching anything, and
 * the engine applies each user's pull-direction preference to this list.
 *
 * Kept separate from `loadLinkedUsers`: outbound push remains credential-gated,
 * and an explicit unlink must not be undone by a scheduled import.
 *
 * OPERATOR NOTE: this is same-name auto-attach, not an opt-in link. A Lumastra
 * account whose username matches an AudiobookShelf account inherits that
 * account's listening progress on the next pull, with no per-user consent step.
 * That is sound only under this integration's stated assumption — both systems
 * are fed by the same identity directory, so equal names mean the same person.
 * `matchAbsUser` fails closed on an ambiguous match, and `PULL_DISABLED_SECRET`
 * (written by an explicit unlink) suppresses this path entirely; an operator who
 * cannot guarantee that assumption should keep the connector's pull direction
 * off rather than rely on those two guards alone.
 */
async function loadPullUsers(
    ctx: PluginContext,
    options?: WatchSyncPullOptions,
): Promise<AudiobookshelfSyncUser[]> {
    return (await selectAudiobookshelfSyncUsers(ctx.sql as never, options)).users;
}

/**
 * ABS session ids Lumastra itself is holding open.
 *
 * Exempting these from the position freeze is what makes resume work: Lumastra
 * keeps an ABS session open server-side while the user is merely PAUSED, so
 * without the exemption the pull the player wants to consume on resume is frozen
 * by the player's own session and the position never advances.
 *
 * Liveness is `status IN ('ACTIVE','PAUSED')` — the predicate every other
 * play_sessions reader uses. There is no `ended_at` column (the terminal stamp
 * is `stopped_at`); an earlier revision filtered on one and every ABS pull
 * aborted with `column "ended_at" does not exist`, which the linked-user gate
 * hid because it returns before this query on an unlinked install. PAUSED must
 * stay in the set: a paused Lumastra session is exactly the case the exemption
 * exists for.
 */
export async function loadOwnSessionIds(ctx: PluginContext): Promise<Set<string>> {
    const rows = await ctx.sql<Array<{ source_session_id: string | null }>>`
        SELECT source_session_id
          FROM play_sessions
         WHERE source = ${AUDIOBOOKSHELF_PROVIDER}
           AND source_session_id IS NOT NULL
           AND status IN ('ACTIVE', 'PAUSED')
    `;
    return new Set(rows.map((r) => r.source_session_id).filter((id): id is string => !!id));
}

async function loadOpenSessions(): Promise<AudiobookSession[]> {
    try {
        return await audiobookshelfClient.getSessions();
    } catch {
        // A failed session read must not fail the pull — it only means we
        // cannot prove anything is playing, so nothing gets frozen. Erring
        // toward "not frozen" keeps positions flowing; the alternative
        // (freezing everything) would stall every user's resume on an ABS hiccup.
        return [];
    }
}

const PULL_USER_CONCURRENCY = 4;

/** Run user pulls concurrently without letting one slow ABS account serialize the cycle. */
async function forEachWithConcurrency<T>(
    values: readonly T[],
    limit: number,
    signal: AbortSignal | undefined,
    fn: (value: T) => Promise<void>,
): Promise<void> {
    let cursor = 0;
    const worker = async (): Promise<void> => {
        while (!signal?.aborted) {
            const index = cursor++;
            if (index >= values.length) return;
            await fn(values[index]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => worker()));
}

export const audiobookshelfWatchSync: WatchSyncDefinition = defineWatchSync({
    id: 'audiobookshelf-watch-sync',
    name: 'AudiobookShelf Watch Sync',
    version: '1.0.0',
    providerName: AUDIOBOOKSHELF_PROVIDER,
    capabilities: { database: true, http: true },

    async isAvailable(): Promise<boolean> {
        return Boolean(config.AUDIOURL && config.AUDIOAPIKEY);
    },

    /**
     * The engine resolves ABS ids through `external_ids` (provider
     * `'audiobookshelf'`, written by the catalog ingest sweep), so there is
     * nothing for the plugin to resolve itself.
     */
    async resolveIds(
        _ctx: PluginContext,
        _items: WatchSyncResolveItem[],
    ): Promise<WatchSyncResolvedId[]> {
        return [];
    },

    async listLinkedUsers(ctx: PluginContext): Promise<string[] | null> {
        const linked = await loadLinkedUsers(ctx);
        // NB: `[]` and `null` are NOT interchangeable here. `[]` means "gated,
        // nobody eligible" (the engine returns early); `null` means "no gating
        // at all" and drains the whole backlog for every user.
        return linked.map((u) => u.userId);
    },

    async listPullUsers(ctx: PluginContext): Promise<string[] | null> {
        return (await loadPullUsers(ctx)).map((u) => u.userId);
    },

    async pullWatchState(
        ctx: PluginContext,
        opts?: WatchSyncPullOptions,
    ): Promise<WatchSyncPullResult> {
        const errors: string[] = [];
        const items: WatchStatePullItem[] = [];
        const newCursors = new Map<string, string>();

        const users = await loadPullUsers(ctx, opts);
        if (users.length === 0) return { items, errors, newCursors };

        const [openSessions, ownSessionIds] = await Promise.all([
            loadOpenSessions(),
            loadOwnSessionIds(ctx),
        ]);
        let absUsersError: unknown;
        // Snapshot taken ONCE for the whole cycle. A session that opens after
        // this read but before a later user's `/api/me` call is not in the set,
        // so that user's position can still be overwritten this cycle. Accepted:
        // the window is one cycle, the next pull (5 min) sees the session and
        // freezes correctly, and the live session lane — not this sweep — is
        // what protects an actively-playing client. Re-reading sessions per user
        // would add a request per user per cycle for a strictly smaller window,
        // not a closed one.
        const frozen = buildFrozenItemKeys(openSessions, Date.now(), ownSessionIds);

        const secrets = new PluginSecrets(ctx.sql);
        let processed = 0;

        await forEachWithConcurrency(users, PULL_USER_CONCURRENCY, opts?.signal, async (user) => {
            try {
                let me: AudiobookMe | null = null;
                const resolution = await user.resolve({
                    readKey: (listener) =>
                        resolveUserApiKey({
                            secrets,
                            deps: credentialDeps,
                            userId: listener.userId,
                            username: listener.username,
                        }),
                    readLinked: (key) => audiobookshelfClient.getMeAs(key, opts?.signal),
                    listUsers: async () => {
                        try {
                            return await audiobookshelfClient.listUsers(opts?.signal);
                        } catch (error) {
                            absUsersError = error;
                            errors.push(
                                `AudiobookShelf user list unavailable; skipped operator-scoped imports this cycle: ${String(error)}`,
                            );
                            throw error;
                        }
                    },
                });
                if (resolution.kind === 'rejected') throw resolution.error;
                if (resolution.kind === 'linked') me = resolution.account;
                else if (resolution.kind === 'name') {
                    me = await audiobookshelfClient.getUserAsAdmin(
                        resolution.account.id,
                        opts?.signal,
                    );
                }
                const progress = (me?.mediaProgress ?? []).filter(isCountableBookProgress);

                // ABS has no `changed-since` parameter, so incrementality is
                // client-side against the engine-supplied cursor.
                const fresh = filterProgressByCursor(progress, opts?.cursors?.get(user.userId));

                for (const row of fresh) {
                    items.push(
                        mapProgressToPullItem(row, user.username, {
                            frozen: frozen.has(frozenKey(user.username, row.libraryItemId)),
                        }),
                    );
                }

                // Cursor advances over the WHOLE set (not just `fresh`) but
                // never past a FROZEN row — see computeNextCursor.
                const frozenIds = new Set(
                    progress
                        .filter((r) => frozen.has(frozenKey(user.username, r.libraryItemId)))
                        .map((r) => r.libraryItemId),
                );
                const nextCursor = computeNextCursor(progress, frozenIds);
                if (nextCursor) newCursors.set(user.username, nextCursor);

                processed += fresh.length;
                opts?.onProgress?.({ processed, currentUser: user.username });
            } catch (error) {
                if (opts?.signal?.aborted) return;
                if (absUsersError && error === absUsersError) return;
                // Per-USER isolation. A revoked key is terminal for that user
                // only and must never fail the cycle for everybody else; a 5xx
                // is transient and simply retries next cycle. Either way the
                // remaining users still sync.
                const rejected =
                    error instanceof AudiobookshelfUserAuthError && error.credentialRejected;
                errors.push(
                    `${user.username}: ${rejected ? 'not linked (key rejected)' : String(error)}`,
                );
                ctx.logger.warn('AudiobookShelf pull failed for one user', {
                    username: user.username,
                    credentialRejected: rejected,
                    error: String(error),
                });
                // Drop the dead key so the next pull can use the operator read
                // path instead of retrying a rejected credential forever.
                // Playback can mint a fresh personal key when the user next
                // starts a book in Lumastra.
                if (rejected) {
                    await forgetUserApiKey({ secrets, userId: user.userId }).catch((e: unknown) =>
                        ctx.logger.warn('AudiobookShelf: failed to clear rejected key', {
                            username: user.username,
                            error: String(e),
                        }),
                    );
                }
                // Drop this user's cursor so a transient failure re-reads the
                // window it did not manage to import.
                newCursors.delete(user.username);
            }
        });

        return { items, errors, newCursors };
    },

    async pushWatchState(
        ctx: PluginContext,
        changes: WatchStateChange[],
        signal?: AbortSignal,
    ): Promise<WatchSyncPushResult> {
        const result: WatchSyncPushResult = {
            succeeded: 0,
            failed: 0,
            skipped: 0,
            staleIds: [],
            errors: [],
            successful: [],
            drainedAsSkipped: [],
            failedItems: [],
        };

        const secrets = new PluginSecrets(ctx.sql);
        const progressClient = batchAudiobookProgressReader(audiobookshelfClient);
        const linked = await loadLinkedUsers(ctx);
        // Keyed by users.id, because `WatchStateChange.username` carries the
        // user_id UUID despite its name (see the SDK type). Matching it against
        // a display name never hit, so every ABS push drained as "no link for
        // this user" and this connector pushed nothing at all — for anyone,
        // since it was written. No fold: a UUID has no case or NFC/NFD variants.
        const byUserId = new Map(linked.map((u) => [u.userId, u]));

        for (const change of changes) {
            if (signal?.aborted) break;

            const user = byUserId.get(change.username);
            if (!user) {
                // No ABS link for this user: terminal. Drain it or it
                // head-of-line-blocks every newer item forever.
                result.skipped++;
                result.drainedAsSkipped.push({
                    username: change.username,
                    mediaId: change.mediaId,
                });
                result.failedItems?.push({
                    username: change.username,
                    mediaId: change.mediaId,
                    error: 'no AudiobookShelf link for this user',
                    terminal: true,
                });
                continue;
            }

            try {
                const apiKey = await resolveUserApiKey({
                    secrets,
                    deps: credentialDeps,
                    userId: user.userId,
                    username: user.username,
                });
                if (!apiKey) {
                    result.skipped++;
                    result.drainedAsSkipped.push({
                        username: change.username,
                        mediaId: change.mediaId,
                    });
                    continue;
                }

                const upstream = await readAudiobookProgress(
                    progressClient,
                    apiKey,
                    change.providerId,
                    signal,
                );
                const occurredAt = change.occurredAt ? new Date(change.occurredAt).getTime() : NaN;
                if (!Number.isFinite(occurredAt))
                    throw new Error('Missing decisive event timestamp');
                if (upstream && upstream.lastUpdate > occurredAt + ABS_TIMESTAMP_TOLERANCE_MS) {
                    result.skipped++;
                    result.drainedAsSkipped.push({
                        username: change.username,
                        mediaId: change.mediaId,
                    });
                    continue;
                }
                // ABS refuses to finish a fresh progress row whose duration is zero.
                if (
                    change.isWatched &&
                    !(change.runtimeMs > 0) &&
                    !(upstream?.duration && upstream.duration > 0)
                ) {
                    throw new Error('Audiobook duration unavailable; finish retained for retry');
                }

                await patchProgress(apiKey, change.providerId, {
                    // ABS clears completion if this PATCH also changes the
                    // position away from the end (mark-watched projects zero).
                    // Assert completion without rewinding the progress row.
                    ...(change.isWatched ? {} : { currentTime: change.resumePositionMs / 1000 }),
                    // Keep a known duration on rows created without playback.
                    // An unknown runtime must not overwrite a good ABS duration.
                    ...(change.runtimeMs > 0 ? { duration: change.runtimeMs / 1000 } : {}),
                    // This lane carries decisive watch/unwatch events. Position
                    // reports use pushResumePosition and never assert a flag.
                    isFinished: change.isWatched,
                });

                result.succeeded++;
                result.successful.push({
                    username: change.username,
                    mediaId: change.mediaId,
                });
            } catch (error) {
                const terminal = error instanceof AudiobookshelfUserAuthError && error.terminal;
                if (error instanceof AudiobookshelfUserAuthError && error.credentialRejected) {
                    // Same self-heal as the pull path: a rejected key must not
                    // stay cached, or every later cycle fails identically.
                    await forgetUserApiKey({ secrets, userId: user.userId }).catch(() => {});
                }
                if (terminal) {
                    result.skipped++;
                    result.drainedAsSkipped.push({
                        username: change.username,
                        mediaId: change.mediaId,
                    });
                } else {
                    result.failed++;
                    result.errors.push(String(error));
                }
                result.failedItems?.push({
                    username: change.username,
                    mediaId: change.mediaId,
                    error: String(error),
                    terminal,
                });
            }
        }

        return result;
    },

    /**
     * Position-only lane. The engine routes progress-only changes here so a
     * moved position never implies a watched-state change.
     */
    async pushResumePosition(
        ctx: PluginContext,
        items: ResumePositionItem[],
        signal?: AbortSignal,
    ): Promise<WatchSyncPushResult> {
        // Reported per item rather than swallowed. The engine marks the backing
        // events pushed only for what comes back here, so a transient failure
        // stays queued for the next cycle instead of being silently drained —
        // which is what made this lane an accelerator with no guarantee behind
        // it, for audiobooks whose resume point ONLY lives upstream.
        const result: WatchSyncPushResult = {
            succeeded: 0,
            failed: 0,
            skipped: 0,
            staleIds: [],
            errors: [],
            successful: [],
            drainedAsSkipped: [],
            failedItems: [],
        };

        const secrets = new PluginSecrets(ctx.sql);
        const progressClient = batchAudiobookProgressReader(audiobookshelfClient);
        const linked = await loadLinkedUsers(ctx);
        // Keyed by users.id — see the note in pushWatchState above.
        const byUserId = new Map(linked.map((u) => [u.userId, u]));

        for (const item of items) {
            if (signal?.aborted) break;

            const drain = (error: string): void => {
                result.skipped++;
                result.drainedAsSkipped.push({
                    username: item.username,
                    mediaId: item.mediaId,
                });
                result.failedItems?.push({
                    username: item.username,
                    mediaId: item.mediaId,
                    error,
                    terminal: true,
                });
            };

            const user = byUserId.get(item.username);
            // Terminal: no ABS link for this user. Drain it or it
            // head-of-line-blocks every newer item forever.
            if (!user) {
                drain('no AudiobookShelf link for this user');
                continue;
            }

            try {
                const apiKey = await resolveUserApiKey({
                    secrets,
                    deps: credentialDeps,
                    userId: user.userId,
                    username: user.username,
                });
                if (!apiKey) {
                    drain('no usable AudiobookShelf credential');
                    continue;
                }
                const resume = await readAudiobookResume({
                    sql: ctx.sql as never,
                    userId: toUserId(item.username),
                    mediaId: item.mediaId,
                    absItemId: item.providerId,
                    apiKey,
                    client: progressClient,
                    fallbackPositionMs: item.resumePositionMs,
                    signal,
                });
                if (!resume.localIsNewest) {
                    // A newer upstream bookmark is an ordinary no-op, not
                    // an item failure. Consume only this batch's old events.
                    result.skipped++;
                    result.drainedAsSkipped.push({
                        username: item.username,
                        mediaId: item.mediaId,
                    });
                    continue;
                }
                await patchProgress(apiKey, item.providerId, {
                    currentTime:
                        item.runtimeMs && item.runtimeMs > 0
                            ? Math.min(resume.positionMs, item.runtimeMs) / 1000
                            : resume.positionMs / 1000,
                    // Same fix as pushWatchState above, for the same reason: a
                    // progress row this PATCH CREATES (a book the listener
                    // never opened in ABS) is born with `duration: 0` unless
                    // we send one, and ABS then refuses to ever mark it
                    // finished — a listener whose progress arrives only
                    // through this lane could never complete the book.
                    //
                    // Guarded on > 0 so an unknown local runtime can never
                    // overwrite a good upstream duration with zero.
                    ...(item.runtimeMs && item.runtimeMs > 0
                        ? { duration: item.runtimeMs / 1000 }
                        : {}),
                });
                result.succeeded++;
                result.successful.push({ username: item.username, mediaId: item.mediaId });
            } catch (error) {
                if (error instanceof AudiobookshelfUserAuthError && error.credentialRejected) {
                    // Same self-heal as the pull path: a rejected key must not
                    // stay cached, or every later cycle fails identically.
                    await forgetUserApiKey({ secrets, userId: user.userId }).catch(() => {});
                }
                // 404/410 means the item is gone upstream — terminal, same
                // verdict pushWatchState reaches. Anything else may succeed
                // next cycle, so leave the events queued.
                if (error instanceof AudiobookshelfUserAuthError && error.terminal) {
                    drain(String(error));
                    continue;
                }
                result.failed++;
                result.errors.push(String(error));
                result.failedItems?.push({
                    username: item.username,
                    mediaId: item.mediaId,
                    error: String(error),
                    terminal: false,
                });
                ctx.logger.debug('AudiobookShelf resume-position push failed; will retry', {
                    userId: item.username,
                    error: String(error),
                });
            }
        }

        return result;
    },
});

/**
 * `PATCH /api/me/progress/:libraryItemId` as a specific user.
 *
 * `currentTime` is SECONDS — ABS's unit, not Lumastra's milliseconds.
 */
async function patchProgress(
    userApiKey: string,
    libraryItemId: string,
    body: { currentTime?: number; duration?: number; isFinished?: boolean },
): Promise<void> {
    // Routed through the same-origin-only redirect guard (C22 fix-plan
    // finding) — matches the sibling AudiobookshelfClient in
    // `$lib/server/audiobookshelf.ts`, which already uses this helper for
    // every other ABS call. This was the one bare, un-timed-out `fetch()`
    // left on the admin-configured, per-user-credentialed ABS surface.
    const response = await fetchWithTimeout(
        joinUpstreamUrl(config.AUDIOURL, `/api/me/progress/${encodePathSegment(libraryItemId)}`),
        {
            method: 'PATCH',
            headers: {
                Authorization: `Bearer ${userApiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        },
    );
    if (!response.ok) {
        // 404/410 here means the library item is gone upstream (or the
        // `external_ids` row is stale) — terminal, so the caller drains it
        // instead of retrying it ahead of every newer item forever.
        throw new AudiobookshelfUserAuthError(
            response.status,
            `PATCH /api/me/progress/${libraryItemId}`,
        );
    }
}

registerWatchSyncWithAutoTasks(audiobookshelfWatchSync);
