// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Session-less push of an audiobook resume position to AudiobookShelf.
 *
 * ## Why this exists separately from the session lane
 *
 * Online audiobook starts read their resume point from ABS's own progress row
 * (`audiobook-session.service.ts` builds `startPositionMs` from `absSession.startTime ?? currentTime`), so a
 * write that reaches only the local watch state is invisible to every later
 * listen — it "succeeds" and changes nothing the listener can see.
 *
 * Online reports push a position through an ABS playback session. Opening a
 * session solely to flush offline progress would allocate a stream. Opening one
 * supersedes the listener's other sessions on that book, consumes a concurrent-stream slot
 * (`UNMETERED_SOURCES` deliberately excludes 'audiobookshelf', so stream
 * policy can REFUSE it), and mints a stream token — three side effects a
 * bookkeeping write has no business causing, and one that can make the write
 * fail on capacity grounds. `PATCH /api/me/progress/:itemId` has none of them.
 *
 * ## What the caller must guarantee
 *
 * ABS's progress row is last-write-wins with NO history, so the position handed
 * to this module must already be arbitrated. Callers pass media ids, not
 * positions, and this module reads the post-rebuild `user_media_state.
 * resume_position_ms` itself — the value the event log settled on, not whatever
 * a client claimed. That is what stops a back-dated offline record from rewinding
 * a newer position set on another device: if the record lost arbitration, the
 * rebuild left `resume_position_ms` alone and the push below is a no-op re-assert
 * of the position ABS already holds.
 *
 * ## Never `isFinished`
 *
 * Completion is ABS's to decide (see `offline-playback.service.ts`'s header for
 * the arbitration freeze a Lumastra-side audiobook completion causes). This
 * module moves a position and nothing else; ABS's own near-end rule finishes the
 * book, and the pull brings that back as an `audiobookshelf-sync` mark.
 *
 * ## Best-effort by contract
 *
 * Every failure here is swallowed and logged. The watch-sync sweep pushes the
 * same positions off the same `lumastra-offline` events (they are in
 * `PUSHABLE_SOURCES`, and an audiobook's progress-only queue routes to
 * `pushResumePosition`), so this module is an ACCELERATOR — it closes the
 * several-minute window in which a flushed position is not yet visible to the
 * web player — and never the durable guarantee. It deliberately does not mark
 * the backing events pushed: re-asserting the same position later is a no-op,
 * whereas marking events pushed after a silently failed write would lose it.
 * The sweep also owns credential self-healing (`forgetUserApiKey` on a rejected
 * key); a dead key here just logs and waits for the next cycle.
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id.js';
import { Logger } from '../utils/logger.js';
import { PluginSecrets } from '../tasks/secrets.js';
import { AUDIOBOOKSHELF_PLUGIN_ID, API_KEY_SECRET } from './audiobookshelf-credentials.service.js';
import {
    AUDIOBOOKSHELF_PROVIDER,
    AUDIOBOOK_MEDIA_TYPE,
} from '../database/queries/audiobooks.queries.js';
import type { AudiobookshelfClient } from '../audiobookshelf.js';

const logger = Logger.for('AudiobookProgressPush');

/** Concurrent upstream PATCHes. A flush of many distinct books is rare; this
 *  exists so a 50-record batch spanning 50 books cannot open 50 sockets. */
const PUSH_CONCURRENCY = 4;

/**
 * The ABS client is injected (and lazily imported by {@link defaultPushDeps})
 * for the same reason every other audiobook module does it: `audiobookshelf.ts`
 * builds its singleton at module scope off `config.AUDIOURL`, and a static
 * import drags that construction into every test that touches this surface.
 */
export interface AudiobookProgressPushDeps {
    client: Pick<AudiobookshelfClient, 'patchProgressAs'>;
}

export async function defaultPushDeps(): Promise<AudiobookProgressPushDeps> {
    const { audiobookshelfClient } = await import('../audiobookshelf.js');
    return { client: audiobookshelfClient };
}

export interface PushAudiobookProgressInput {
    sql: postgres.Sql;
    userId: UserId;
    /** Audiobook media ids whose local state was just rebuilt. */
    mediaIds: readonly string[];
    deps?: AudiobookProgressPushDeps;
}

export interface PushAudiobookProgressResult {
    pushed: number;
    /** No ABS link, push disabled, no upstream id, or no position to assert. */
    skipped: number;
    failed: number;
}

const NOTHING: PushAudiobookProgressResult = { pushed: 0, skipped: 0, failed: 0 };

interface PushRow {
    media_id: string;
    resume_position_ms: number;
    abs_item_id: string;
    /** Seconds, `media_items.runtime_seconds`. Null when unknown. */
    runtime_seconds: number | null;
}

/**
 * Push the arbitrated resume position of each given audiobook to ABS.
 *
 * Gated on ONE thing: an ABS credential must already exist for this user. Read
 * directly rather than through `resolveUserApiKey`, which would MINT one by
 * same-name match — an auto-link is not something a background bookkeeping
 * flush should trigger on a user's behalf.
 *
 * ## Why sync direction is deliberately NOT consulted
 *
 * It is tempting to mirror the watch-sync sweep, which skips users whose
 * direction is 'pull'. That is the wrong precedent, and applying it here broke
 * an invariant that matters more.
 *
 * The sweep exports WATCH STATE BETWEEN SYSTEMS — a genuine export, and
 * something a user can reasonably decline. This module reports THE USER'S OWN
 * PLAYBACK, late. Live audiobook playback already writes the listener's
 * position straight to ABS via `syncSessionAs`/`closeSessionAs`
 * (`audiobook-session.service.ts`), for every linked user, with no direction
 * check anywhere in that path — because playing a book through Lumastra IS an
 * AudiobookShelf session.
 *
 * So gating here would mean the same listener, on the same book, gets a
 * different outcome depending on whether their device happened to have a
 * network connection at the time: online listening moves their resume point,
 * a flight's worth of offline listening silently does not. Behaviour must not
 * depend on connectivity — that is the whole point of the catch-up endpoint.
 *
 * This exposes nothing new: a listener with an ABS credential is already having
 * their live positions written upstream in their own name. Completion is still
 * never asserted from here (see the header), which is the part a 'pull' user
 * would actually be protected from.
 */
/**
 * A position, bounded by the book's own length.
 *
 * The arbitrated position comes from client reports, and nothing on the way
 * in compares one against the media's real runtime — so a broken client timer
 * can produce a position past the end of the book. AudiobookShelf's progress
 * row is last-write-wins with no history, which makes an implausible
 * currentTime there permanent until something overwrites it.
 *
 * A zero or missing runtime returns the position untouched: an unknown length
 * is not a reason to move a listener's position.
 */
function clampToRuntime(positionMs: number, runtimeSeconds: number | null): number {
    if (!runtimeSeconds || runtimeSeconds <= 0) return positionMs;
    return Math.min(positionMs, Math.round(runtimeSeconds * 1000));
}

export async function pushAudiobookProgressToAbs(
    input: PushAudiobookProgressInput,
): Promise<PushAudiobookProgressResult> {
    const { sql, userId } = input;
    const mediaIds = [...new Set(input.mediaIds)];
    if (mediaIds.length === 0) return NOTHING;

    const apiKey = await new PluginSecrets(sql)
        .getUserRaw(AUDIOBOOKSHELF_PLUGIN_ID, userId, API_KEY_SECRET)
        .catch(() => null);
    if (!apiKey) return { ...NOTHING, skipped: mediaIds.length };

    // The arbitrated position, joined to the upstream id. `resume_position_ms
    // > 0` mirrors the sweep's own predicate: position zero is "no resume
    // point", and asserting it would rewind the book to the start.
    // The access decision lives at the caller: these rows are the CALLER'S OWN
    // user_media_state, scoped by `ums.user_id`, and the only thing read off
    // media_items is `runtime_seconds` for a book this same user already has a
    // resume position in — pushed to that user's own AudiobookShelf account
    // with their own API key. There is no cross-user or cross-library reach
    // here for a library filter to narrow.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    const rows = await sql<PushRow[]>`
        SELECT ums.media_id::text AS media_id,
               ums.resume_position_ms,
               ei.external_id AS abs_item_id,
               mi.runtime_seconds
        FROM user_media_state ums
        JOIN external_ids ei
          ON ei.media_id   = ums.media_id
         AND ei.provider   = ${AUDIOBOOKSHELF_PROVIDER}
         AND ei.media_type = ${AUDIOBOOK_MEDIA_TYPE}
        -- LEFT so a state row whose media_item is gone still pushes its
        -- position, with duration simply omitted for it. An inner join here
        -- would let an unrelated referential gap silently drop the push.
        LEFT JOIN media_items mi ON mi.id = ums.media_id
        WHERE ums.user_id  = ${userId}
          AND ums.media_id = ANY(${sql.array(mediaIds)}::uuid[])
          AND (
                ums.resume_position_ms > 0
                -- A deliberate reset has to reach ABS too, or Lumastra says
                -- "start over" and ABS keeps the old position forever. Scoped
                -- as tightly as it can be: only a LUMASTRA USER MARK, and only
                -- one that left the book unwatched. Dropping the > 0 filter
                -- outright would push a zero for every book the listener has
                -- never opened here, overwriting real upstream progress with
                -- nothing — which is the failure this filter was guarding.
                OR (ums.is_watched = false AND ums.last_event_source = 'lumastra-user-mark')
              )
    `.catch((err: unknown) => {
        logger.warn('Could not read arbitrated audiobook positions to push', {
            userId,
            error: String(err),
        });
        return [] as PushRow[];
    });

    const result: PushAudiobookProgressResult = {
        pushed: 0,
        skipped: mediaIds.length - rows.length,
        failed: 0,
    };
    if (rows.length === 0) return result;

    const deps = input.deps ?? (await defaultPushDeps());

    let cursor = 0;
    const worker = async (): Promise<void> => {
        for (;;) {
            const row = rows[cursor++];
            if (!row) return;
            try {
                // `currentTime` is SECONDS — ABS's unit, not Lumastra's ms.
                //
                // `duration` is sent so a progress row this PATCH CREATES is
                // not born with `duration: 0`. Measured against the live
                // server (see pushWatchState's identical comment in
                // watch-sync/audiobookshelf.ts): a row for a book the
                // listener never opened in ABS is created by this PATCH, and
                // without a duration ABS stores `duration: 0` and then
                // refuses `isFinished` — so this lane's whole reason to
                // exist (closing the window before ABS's near-end rule can
                // fire) would silently never let that rule fire at all for a
                // download-only listener.
                //
                // Guarded on > 0 so an unknown local runtime can never
                // overwrite a good upstream duration with zero.
                const known = await deps.client.patchProgressAs(apiKey, row.abs_item_id, {
                    // Clamped to the book's own runtime. `resume_position_ms`
                    // is arbitrated from client-supplied positions, and
                    // nothing upstream of here bounds one against the media's
                    // real length — so a client with a broken timer could
                    // PATCH a currentTime past the end of the book into ABS,
                    // whose progress row is last-write-wins with no history.
                    // Only clamped when the runtime is actually known; a
                    // missing one must not silently pin every position to 0.
                    currentTime: clampToRuntime(row.resume_position_ms, row.runtime_seconds) / 1000,
                    ...(row.runtime_seconds && row.runtime_seconds > 0
                        ? { duration: row.runtime_seconds }
                        : {}),
                });
                // false is a 404: ABS no longer knows the item. Routine (a
                // deleted book, a stale external_ids row), not a failure.
                if (known) result.pushed++;
                else result.skipped++;
            } catch (err) {
                result.failed++;
                logger.warn('AudiobookShelf progress push failed; sweep will retry', {
                    mediaId: row.media_id,
                    absItemId: row.abs_item_id,
                    error: String(err),
                });
            }
        }
    };
    await Promise.all(
        Array.from({ length: Math.min(PUSH_CONCURRENCY, rows.length) }, () => worker()),
    );

    return result;
}
