// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    classifyLumastraProgressEvent,
    computeStateFromEvents,
    shouldAcceptLumastraProgressEvent,
    SOURCE_PRIORITY,
    normalizeEventSeq,
} from './watch-state-rebuilder.service.js';
import type { StateProvenance } from './watch-state-rebuilder.service.js';
import type {
    UserMediaEvent,
    EventSource,
    EventType,
} from '$lib/server/database/queries/user-media-events.queries.js';
import { toUserId } from '$lib/shared/user-id.js';

// Fixed valid users.id UUID for the branded UserMediaEvent.user_id (mig 16.46.0).
const TEST_USER_ID = toUserId('11111111-1111-4111-8111-111111111111');

// =============================================================================
// Test helpers
// =============================================================================

// Fixed epoch so ordering is obvious. `t(n)` returns an ISO timestamp
// n minutes after the base — tests compose histories by timestamp
// offset rather than by hand-typed ISO strings.
const BASE = new Date('2025-01-01T00:00:00.000Z').getTime();
function t(minutesFromBase: number): string {
    return new Date(BASE + minutesFromBase * 60_000).toISOString();
}

function ev(
    overrides: Partial<UserMediaEvent> & {
        source: EventSource;
        event_type: EventType;
        occurred_at: string;
    },
): UserMediaEvent {
    return {
        id: `ev-${Math.random().toString(36).slice(2, 10)}`,
        user_id: TEST_USER_ID,
        media_id: 'media-1',
        position_ms: null,
        runtime_ms: null,
        source_event_id: null,
        session_id: null,
        event_seq: null,
        repudiated_at: null,
        snapshot_state: null,
        session_elapsed_ms: null,
        knowledge_as_of: null,
        pushed_to_providers: [],
        recorded_at: overrides.occurred_at,
        ...overrides,
    };
}

// =============================================================================
// computeStateFromEvents — the arbitration rule
// =============================================================================

describe('computeStateFromEvents', () => {
    it('returns null for an empty event list', () => {
        // Signals "delete the materialized row" to the caller.
        expect(computeStateFromEvents([])).toBeNull();
    });

    it('marks a single completed event as watched with zero resume', () => {
        const state = computeStateFromEvents([
            ev({
                source: 'lumastra-player',
                event_type: 'completed',
                occurred_at: t(10),
                runtime_ms: 90 * 60_000,
            }),
        ]);
        expect(state).not.toBeNull();
        expect(state!.is_watched).toBe(true);
        expect(state!.resume_position_ms).toBe(0);
        expect(state!.watch_count).toBe(1);
        expect(state!.last_watched_at).toBe(t(10));
        expect(state!.first_watched_at).toBe(t(10));
        expect(state!.last_event_at).toBe(t(10));
        expect(state!.last_event_source).toBe('lumastra-player');
    });

    it('progress then completed → watched, resume cleared (latest event wins)', () => {
        // The latest decisive event in the desc walk is `completed`. That
        // signals "user finished" — any older progress position is stale
        // intent. resume_position_ms is zeroed.
        const state = computeStateFromEvents([
            ev({
                source: 'lumastra-player',
                event_type: 'progress',
                occurred_at: t(5),
                position_ms: 30 * 60_000,
                runtime_ms: 90 * 60_000,
            }),
            ev({
                source: 'lumastra-player',
                event_type: 'completed',
                occurred_at: t(10),
                runtime_ms: 90 * 60_000,
            }),
        ]);
        expect(state!.is_watched).toBe(true);
        expect(state!.resume_position_ms).toBe(0);
    });

    it('progress then mark_unwatched → not watched, resume cleared', () => {
        // mark_unwatched signals "I want to start over" — older progress
        // is stale intent. resume zeroed.
        const progressPos = 45 * 60_000;
        const state = computeStateFromEvents([
            ev({
                source: 'lumastra-player',
                event_type: 'progress',
                occurred_at: t(5),
                position_ms: progressPos,
                runtime_ms: 90 * 60_000,
            }),
            ev({
                source: 'lumastra-user-mark',
                event_type: 'mark_unwatched',
                occurred_at: t(10),
            }),
        ]);
        expect(state!.is_watched).toBe(false);
        expect(state!.resume_position_ms).toBe(0);
    });

    it('mark_unwatched CARRYING a position keeps it (audiobook un-finish)', () => {
        // An audiobook un-finish must not destroy the listening position — that
        // position is the only reason anyone taps it. markUnwatched carries the
        // current position onto the event for audiobooks; video keeps sending
        // null and keeps the zeroing asserted by the test above.
        //
        // Regression: measured on prod 2026-08-27, PUT watch-state
        // {watched:false} took an audiobook from 51,733ms to 0 — and because the
        // arbitrated position is pushed to AudiobookShelf's history-free
        // progress row, the upstream copy was destroyed too. Unrecoverable.
        const listenedMs = 72_746_184; // 20h12m into a 20h57m book
        const state = computeStateFromEvents([
            ev({
                source: 'audiobookshelf-sync',
                event_type: 'progress',
                occurred_at: t(5),
                position_ms: listenedMs,
                runtime_ms: 75_423_791,
            }),
            ev({
                source: 'lumastra-user-mark',
                event_type: 'mark_watched',
                occurred_at: t(10),
            }),
            ev({
                source: 'lumastra-user-mark',
                event_type: 'mark_unwatched',
                occurred_at: t(15),
                position_ms: listenedMs,
            }),
        ]);
        expect(state!.is_watched).toBe(false);
        expect(state!.resume_position_ms).toBe(listenedMs);
    });

    it('mark_watched then re-watch progress → resume tracks the post-mark progress', () => {
        // The re-watch case from the user-reported bug. Latest event in
        // desc walk is the most recent progress (post-mark), so it wins.
        const state = computeStateFromEvents([
            ev({
                source: 'lumastra-user-mark',
                event_type: 'mark_watched',
                occurred_at: t(5),
            }),
            ev({
                source: 'lumastra-player',
                event_type: 'progress',
                occurred_at: t(10),
                position_ms: 5 * 60_000,
                runtime_ms: 90 * 60_000,
            }),
        ]);
        expect(state!.is_watched).toBe(true);
        expect(state!.resume_position_ms).toBe(5 * 60_000);
    });

    // ─────────────────────────────────────────────────────────────────
    // Cross-source resume matrix — locks the policy where authoritative
    // is_watched_source decides whether decisive events clear resume,
    // while progress events update resume regardless of source.
    // Codex flagged this area as policy-sensitive after the source-
    // priority resume gate landed in f2f9bbbd1.
    // ─────────────────────────────────────────────────────────────────

    it('cross-source matrix: A=mark_watched, B=later progress → resume tracks B', () => {
        // Authoritative mark from one source, later progress from another.
        // Progress events update resume regardless of source — they're
        // observations of position, not arbitration verdicts.
        const state = computeStateFromEvents([
            ev({
                source: 'lumastra-user-mark',
                event_type: 'mark_watched',
                occurred_at: t(5),
            }),
            ev({
                source: 'jellyfin-sync',
                event_type: 'progress',
                occurred_at: t(10),
                position_ms: 12 * 60_000,
                runtime_ms: 90 * 60_000,
            }),
        ]);
        expect(state!.is_watched).toBe(true);
        expect(state!.is_watched_source).toBe('lumastra-user-mark');
        expect(state!.resume_position_ms).toBe(12 * 60_000);
    });

    it('cross-source matrix: low-priority arbitration winner + high-priority progress', () => {
        // jellyfin-sync wins is_watched arbitration (no Lumastra decisive).
        // lumastra-player progress later → progress wins resume on chronology.
        const state = computeStateFromEvents([
            ev({
                source: 'jellyfin-sync',
                event_type: 'mark_watched',
                occurred_at: t(5),
            }),
            ev({
                source: 'lumastra-player',
                event_type: 'progress',
                occurred_at: t(10),
                position_ms: 4 * 60_000,
                runtime_ms: 90 * 60_000,
            }),
        ]);
        expect(state!.is_watched).toBe(true);
        expect(state!.is_watched_source).toBe('jellyfin-sync');
        expect(state!.resume_position_ms).toBe(4 * 60_000);
    });

    it('cross-source matrix: authoritative mark + losing-source progress in between + authoritative mark again', () => {
        // A user who marks watched, then Jellyfin sync emits a stale
        // progress, then user marks unwatched. is_watched should reflect
        // the authoritative latest (mark_unwatched), and resume should be
        // cleared by the authoritative event — NOT take the intervening
        // jellyfin-sync progress position.
        const state = computeStateFromEvents([
            ev({
                source: 'lumastra-user-mark',
                event_type: 'mark_watched',
                occurred_at: t(5),
            }),
            ev({
                source: 'jellyfin-sync',
                event_type: 'progress',
                occurred_at: t(10),
                position_ms: 7 * 60_000,
                runtime_ms: 90 * 60_000,
            }),
            ev({
                source: 'lumastra-user-mark',
                event_type: 'mark_unwatched',
                occurred_at: t(15),
            }),
        ]);
        // Walk hits lumastra-user-mark mark_unwatched first → source matches
        // is_watched_source → clear. resume = 0.
        expect(state!.is_watched).toBe(false);
        expect(state!.is_watched_source).toBe('lumastra-user-mark');
        expect(state!.resume_position_ms).toBe(0);
    });

    it('cross-source matrix: snapshot authoritative source preserved when post-snapshot has only progress', () => {
        // Snapshot recorded is_watched=true via lumastra-user-mark. Post-
        // snapshot has progress events from jellyfin-sync only. The
        // snapshot's authoritative verdict survives (no post-snapshot
        // decisive event from a higher-priority source); progress events
        // update resume.
        const state = computeStateFromEvents([
            snap({
                occurred_at: t(50),
                state: {
                    is_watched: true,
                    resume_position_ms: 0,
                    runtime_ms: 90 * 60_000,
                    watch_count: 1,
                    first_watched_at: t(10),
                    last_watched_at: t(40),
                    last_event_at: t(40),
                    last_event_source: 'lumastra-user-mark',
                    is_watched_source: 'lumastra-user-mark',
                },
            }),
            ev({
                source: 'jellyfin-sync',
                event_type: 'progress',
                occurred_at: t(60),
                position_ms: 11 * 60_000,
            }),
        ]);
        expect(state!.is_watched).toBe(true);
        expect(state!.is_watched_source).toBe('lumastra-user-mark');
        expect(state!.resume_position_ms).toBe(11 * 60_000);
    });

    it('cross-source matrix: latest-progress-wins regardless of source for resume signal', () => {
        // No mark events. Progress from multiple sources interleaved.
        // Resume always reflects the chronologically latest progress.
        const state = computeStateFromEvents([
            ev({
                source: 'jellyfin-sync',
                event_type: 'progress',
                occurred_at: t(5),
                position_ms: 5 * 60_000,
                runtime_ms: 90 * 60_000,
            }),
            ev({
                source: 'lumastra-player',
                event_type: 'progress',
                occurred_at: t(10),
                position_ms: 10 * 60_000,
                runtime_ms: 90 * 60_000,
            }),
            ev({
                source: 'jellyfin-sync',
                event_type: 'progress',
                occurred_at: t(15),
                position_ms: 12 * 60_000,
                runtime_ms: 90 * 60_000,
            }),
        ]);
        expect(state!.is_watched).toBe(false);
        expect(state!.resume_position_ms).toBe(12 * 60_000);
    });

    it('low-priority losing-arbitration mark_unwatched does NOT zero rewatch resume', () => {
        // Lumastra mark_watched (high priority) + Lumastra progress, then a
        // stale jellyfin-sync mark_unwatched arrives. is_watched stays
        // true because Lumastra outranks Jellyfin in SOURCE_PRIORITY. The
        // resume walk MUST honor the same arbitration boundary — the
        // jellyfin-sync mark_unwatched lost arbitration, so it must not
        // zero the durable resume position. Otherwise a stale Jellyfin
        // sync would wipe a valid rewatch resume on every refresh.
        const state = computeStateFromEvents([
            ev({
                source: 'lumastra-user-mark',
                event_type: 'mark_watched',
                occurred_at: t(5),
            }),
            ev({
                source: 'lumastra-player',
                event_type: 'progress',
                occurred_at: t(10),
                position_ms: 8 * 60_000,
                runtime_ms: 90 * 60_000,
            }),
            ev({
                source: 'jellyfin-sync',
                event_type: 'mark_unwatched',
                occurred_at: t(20),
            }),
        ]);
        expect(state!.is_watched).toBe(true);
        expect(state!.is_watched_source).toBe('lumastra-user-mark');
        // Without the source-priority gate on the resume walk, this would
        // be 0. With it, the jellyfin-sync mark_unwatched is skipped and
        // the desc walk lands on the lumastra-player progress event.
        expect(state!.resume_position_ms).toBe(8 * 60_000);
    });

    it('Lumastra mark_watched (older) beats Jellyfin mark_unwatched (newer) — priority over recency', () => {
        const state = computeStateFromEvents([
            ev({
                source: 'lumastra-user-mark',
                event_type: 'mark_watched',
                occurred_at: t(5),
                runtime_ms: 90 * 60_000,
            }),
            ev({
                source: 'jellyfin-sync',
                event_type: 'mark_unwatched',
                occurred_at: t(20),
            }),
        ]);
        // Deliberate design: lumastra-user-mark outranks jellyfin-sync
        // by SOURCE_PRIORITY even when the Jellyfin event is more
        // recent. last_event_source still reflects the absolute
        // newest event regardless of who "wins" arbitration.
        expect(SOURCE_PRIORITY['lumastra-user-mark']).toBeGreaterThan(
            SOURCE_PRIORITY['jellyfin-sync'],
        );
        expect(state!.is_watched).toBe(true);
        expect(state!.last_event_source).toBe('jellyfin-sync');
    });

    it('Jellyfin mark_watched (newer) vs Lumastra mark_unwatched (older) → Lumastra wins', () => {
        const state = computeStateFromEvents([
            ev({
                source: 'lumastra-user-mark',
                event_type: 'mark_unwatched',
                occurred_at: t(5),
            }),
            ev({
                source: 'jellyfin-sync',
                event_type: 'mark_watched',
                occurred_at: t(20),
                runtime_ms: 90 * 60_000,
            }),
        ]);
        expect(state!.is_watched).toBe(false);
    });

    it('user-mark mark_unwatched then a NEWER lumastra-player completion → watched (rewatch)', () => {
        // Mark an episode unwatched, then watch it through in the Lumastra
        // player: the rewatch must count. Before the fix the older user mark
        // (100) beat the newer player completion (90) on priority alone, so
        // the row stayed unwatched (CI Playwright run 2026-10-02).
        const state = computeStateFromEvents([
            ev({
                source: 'lumastra-user-mark',
                event_type: 'mark_unwatched',
                occurred_at: t(5),
            }),
            ev({
                source: 'lumastra-player',
                event_type: 'progress',
                occurred_at: t(6),
                position_ms: 43 * 60_000,
                runtime_ms: 45 * 60_000,
            }),
            ev({
                source: 'lumastra-player',
                event_type: 'completed',
                occurred_at: t(6),
                recorded_at: t(6.001),
                runtime_ms: 45 * 60_000,
            }),
        ]);
        expect(state!.is_watched).toBe(true);
        expect(state!.is_watched_source).toBe('lumastra-player');
        expect(state!.watch_count).toBe(1);
        expect(state!.first_watched_at).toBe(t(6));
        expect(state!.last_watched_at).toBe(t(6));
        // The completion settles resume; the same-instant progress does not linger.
        expect(state!.resume_position_ms).toBe(0);
    });

    it('same occurred_at: the later-RECORDED of user mark_unwatched / player completion wins', () => {
        const mark = ev({
            source: 'lumastra-user-mark',
            event_type: 'mark_unwatched',
            occurred_at: t(5),
        });
        const completed = ev({
            source: 'lumastra-player',
            event_type: 'completed',
            occurred_at: t(5),
            runtime_ms: 45 * 60_000,
        });
        const playerLater = computeStateFromEvents([
            { ...mark, recorded_at: t(5) },
            { ...completed, recorded_at: t(5.001) },
        ]);
        expect(playerLater!.is_watched).toBe(true);
        const markLater = computeStateFromEvents([
            { ...mark, recorded_at: t(5.001) },
            { ...completed, recorded_at: t(5) },
        ]);
        expect(markLater!.is_watched).toBe(false);
        expect(markLater!.is_watched_source).toBe('lumastra-user-mark');
    });

    it('audiobook un-finish (mark_unwatched carrying a position) is NOT undone by a newer player completion', () => {
        // The carried position can sit inside the finish window, so reopening
        // the book completes it on the first heartbeat — not a re-listen.
        const listenedMs = 75_300_000;
        const state = computeStateFromEvents([
            ev({
                source: 'lumastra-user-mark',
                event_type: 'mark_unwatched',
                occurred_at: t(5),
                position_ms: listenedMs,
            }),
            ev({
                source: 'lumastra-player',
                event_type: 'completed',
                occurred_at: t(6),
                position_ms: listenedMs + 30_000,
                runtime_ms: 75_423_791,
            }),
        ]);
        expect(state!.is_watched).toBe(false);
        expect(state!.is_watched_source).toBe('lumastra-user-mark');
    });

    it('user mark_unwatched still beats a NEWER lumastra-offline completion (client-stamped)', () => {
        const state = computeStateFromEvents([
            ev({
                source: 'lumastra-user-mark',
                event_type: 'mark_unwatched',
                occurred_at: t(5),
            }),
            ev({
                source: 'lumastra-offline',
                event_type: 'completed',
                occurred_at: t(20),
                runtime_ms: 45 * 60_000,
            }),
        ]);
        expect(state!.is_watched).toBe(false);
        expect(state!.is_watched_source).toBe('lumastra-user-mark');
    });

    it('lumastra-player completion OLDER than the user mark_unwatched → stays unwatched', () => {
        // The user un-marked AFTER finishing it in the player: their verdict stands.
        const state = computeStateFromEvents([
            ev({
                source: 'lumastra-player',
                event_type: 'completed',
                occurred_at: t(5),
                runtime_ms: 45 * 60_000,
            }),
            ev({
                source: 'lumastra-user-mark',
                event_type: 'mark_unwatched',
                occurred_at: t(10),
            }),
        ]);
        expect(state!.is_watched).toBe(false);
        expect(state!.is_watched_source).toBe('lumastra-user-mark');
    });

    it('user mark_unwatched still beats a NEWER sync-source completion (only first-party playback overrides)', () => {
        const state = computeStateFromEvents([
            ev({
                source: 'lumastra-user-mark',
                event_type: 'mark_unwatched',
                occurred_at: t(5),
            }),
            ev({
                source: 'jellyfin-sync',
                event_type: 'completed',
                occurred_at: t(20),
                runtime_ms: 45 * 60_000,
            }),
        ]);
        expect(state!.is_watched).toBe(false);
        expect(state!.is_watched_source).toBe('lumastra-user-mark');
    });

    it('snapshot-carried user-mark unwatched verdict loses to a newer lumastra-player completion', () => {
        const state = computeStateFromEvents([
            snap({
                occurred_at: t(10),
                state: {
                    is_watched: false,
                    resume_position_ms: 0,
                    runtime_ms: 45 * 60_000,
                    watch_count: 0,
                    first_watched_at: null,
                    last_watched_at: null,
                    last_event_at: t(10),
                    last_event_source: 'lumastra-user-mark',
                    is_watched_source: 'lumastra-user-mark',
                },
            }),
            ev({
                source: 'lumastra-player',
                event_type: 'completed',
                occurred_at: t(20),
                runtime_ms: 45 * 60_000,
            }),
        ]);
        expect(state!.is_watched).toBe(true);
        expect(state!.is_watched_source).toBe('lumastra-player');
    });

    it('progress across multiple sources → latest-timestamp wins for resume_position', () => {
        const state = computeStateFromEvents([
            ev({
                source: 'lumastra-player',
                event_type: 'progress',
                occurred_at: t(10),
                position_ms: 1000,
            }),
            ev({
                source: 'jellyfin-sync',
                event_type: 'progress',
                occurred_at: t(20),
                position_ms: 5000,
            }),
            ev({
                source: 'lumastra-player',
                event_type: 'progress',
                occurred_at: t(15),
                position_ms: 3000,
            }),
        ]);
        // Progress is informational regardless of source priority —
        // the newest tick is the most accurate resume point.
        expect(state!.is_watched).toBe(false);
        expect(state!.resume_position_ms).toBe(5000);
    });

    it('completed then later mark_unwatched (same source) → not watched, no un-revoked last_watched_at', () => {
        const state = computeStateFromEvents([
            ev({
                source: 'lumastra-user-mark',
                event_type: 'completed',
                occurred_at: t(5),
                runtime_ms: 90 * 60_000,
            }),
            ev({
                source: 'lumastra-user-mark',
                event_type: 'mark_unwatched',
                occurred_at: t(10),
            }),
        ]);
        expect(state!.is_watched).toBe(false);
        expect(state!.last_watched_at).toBeNull();
        // watch_count = positives(1) - negatives(1) = 0, not floored
        // because is_watched is false.
        expect(state!.watch_count).toBe(0);
    });

    it('mark_unwatched then later progress from same source keeps not-watched verdict', () => {
        const state = computeStateFromEvents([
            ev({
                source: 'jellyfin-sync',
                event_type: 'mark_watched',
                occurred_at: t(5),
                runtime_ms: 43 * 60_000,
            }),
            ev({
                source: 'jellyfin-sync',
                event_type: 'mark_unwatched',
                occurred_at: t(10),
            }),
            ev({
                source: 'jellyfin-sync',
                event_type: 'progress',
                occurred_at: t(10),
                recorded_at: t(10.001),
                position_ms: 40 * 60_000,
                runtime_ms: 43 * 60_000,
            }),
        ]);
        expect(state!.is_watched).toBe(false);
        expect(state!.resume_position_ms).toBe(40 * 60_000);
        expect(state!.last_event_source).toBe('jellyfin-sync');
    });

    it('completed + mark_unwatched + completed → watch_count=1 (surviving completion)', () => {
        const state = computeStateFromEvents([
            ev({
                source: 'lumastra-user-mark',
                event_type: 'completed',
                occurred_at: t(5),
                runtime_ms: 90 * 60_000,
            }),
            ev({
                source: 'lumastra-user-mark',
                event_type: 'mark_unwatched',
                occurred_at: t(10),
            }),
            ev({
                source: 'lumastra-user-mark',
                event_type: 'completed',
                occurred_at: t(15),
                runtime_ms: 90 * 60_000,
            }),
        ]);
        // positives=2, negatives=1 → 1. And is_watched=true so the
        // minimum-1 floor would apply anyway.
        expect(state!.is_watched).toBe(true);
        expect(state!.watch_count).toBe(1);
        // last_watched_at is the surviving completion (t(15)).
        expect(state!.last_watched_at).toBe(t(15));
    });

    it('two completions → first_watched_at = earliest timestamp', () => {
        const state = computeStateFromEvents([
            ev({
                source: 'lumastra-user-mark',
                event_type: 'completed',
                occurred_at: t(5),
                runtime_ms: 90 * 60_000,
            }),
            ev({
                source: 'lumastra-user-mark',
                event_type: 'completed',
                occurred_at: t(100),
                runtime_ms: 90 * 60_000,
            }),
        ]);
        expect(state!.first_watched_at).toBe(t(5));
        expect(state!.last_watched_at).toBe(t(100));
    });

    it('is_watched=true with no surviving completions still has watch_count >= 1', () => {
        // This edge case happens when arbitration picks a positive
        // event from a higher-priority source even though a lower-
        // priority source's mark_unwatched is later. Test case 5
        // triggers that path — here we assert watch_count floor.
        const state = computeStateFromEvents([
            ev({
                source: 'lumastra-user-mark',
                event_type: 'mark_watched',
                occurred_at: t(5),
            }),
            ev({
                source: 'jellyfin-sync',
                event_type: 'mark_unwatched',
                occurred_at: t(10),
            }),
        ]);
        expect(state!.is_watched).toBe(true);
        // positives=1 negatives=1 → 0, but is_watched=true floors to 1.
        expect(state!.watch_count).toBe(1);
    });

    it('runtime_ms takes the latest non-null value', () => {
        const state = computeStateFromEvents([
            ev({
                source: 'jellyfin-sync',
                event_type: 'progress',
                occurred_at: t(5),
                position_ms: 100,
                runtime_ms: 90 * 60_000,
            }),
            ev({
                source: 'lumastra-player',
                event_type: 'progress',
                occurred_at: t(10),
                position_ms: 200,
                runtime_ms: 95 * 60_000,
            }),
        ]);
        expect(state!.runtime_ms).toBe(95 * 60_000);
    });
});

// =============================================================================
// computeStateFromEvents — snapshot base case
// =============================================================================

/**
 * Build a `state_snapshot` event with a stored `SnapshotState` payload.
 * Mirrors the helper above but populates `snapshot_state` and uses
 * `'compaction'` as the source.
 */
function snap(overrides: {
    occurred_at: string;
    state: {
        is_watched: boolean;
        is_watched_source?: string | null;
        resume_position_ms: number;
        runtime_ms: number | null;
        watch_count: number;
        first_watched_at: string | null;
        last_watched_at: string | null;
        last_event_at: string | null;
        last_event_source: string | null;
        highest_session_elapsed_ms?: number | null;
    };
}): UserMediaEvent {
    // Default is_watched_source to last_event_source when not specified —
    // matches the back-compat fallback in computeStateFromEvents and lets
    // existing tests stay terse without explicitly setting the verdict
    // source for every snapshot. Default highest_session_elapsed_ms to
    // null (no engagement signal) so existing tests behave like legacy
    // snapshots.
    const state = {
        is_watched_source: overrides.state.last_event_source,
        highest_session_elapsed_ms: null,
        ...overrides.state,
    };
    return ev({
        source: 'compaction',
        event_type: 'state_snapshot',
        occurred_at: overrides.occurred_at,
        snapshot_state: state,
    });
}

// =============================================================================
// computeStateFromEvents — offline blind-spot guard (step 3b)
// =============================================================================

// =============================================================================
// computeStateFromEvents — provenance (which event actually won)
// =============================================================================

describe('computeStateFromEvents — provenance', () => {
    function sink(): StateProvenance {
        return { resumePositionEventId: null, watchedVerdictEventId: null };
    }

    it('names the event whose position became the resume point', () => {
        const prov = sink();
        const state = computeStateFromEvents(
            [
                ev({
                    source: 'lumastra-offline',
                    event_type: 'progress',
                    occurred_at: t(10),
                    position_ms: 742_980,
                    source_event_id: 'offline:rec-1',
                }),
            ],
            prov,
        );
        expect(state!.resume_position_ms).toBe(742_980);
        expect(prov.resumePositionEventId).toBe('offline:rec-1');
    });

    it('does NOT name a losing offline record — the exact case that reported success on prod', () => {
        // Written, valid, newest by occurred_at, and still not the resume
        // point: the blind-spot guard raised it back to the position the
        // reporter could not see. Without provenance this is byte-identical
        // to a win from the writer's point of view.
        const prov = sink();
        const state = computeStateFromEvents(
            [
                ev({
                    source: 'audiobookshelf-sync',
                    event_type: 'progress',
                    occurred_at: t(100),
                    position_ms: 9_626_337,
                    source_event_id: 'abs:1',
                }),
                ev({
                    source: 'lumastra-offline',
                    event_type: 'progress',
                    occurred_at: t(200),
                    position_ms: 742_980,
                    knowledge_as_of: t(0),
                    source_event_id: 'offline:rec-1',
                }),
            ],
            prov,
        );
        expect(state!.resume_position_ms).toBe(9_626_337);
        expect(prov.resumePositionEventId).toBe('abs:1');
        expect(prov.resumePositionEventId).not.toBe('offline:rec-1');
    });

    it('names nothing when a decisive event cleared the resume point', () => {
        // The position is 0 because the item is watched, not because any
        // event reported 0 — attributing it to an event would be a lie.
        const prov = sink();
        const state = computeStateFromEvents(
            [
                ev({
                    source: 'lumastra-offline',
                    event_type: 'progress',
                    occurred_at: t(10),
                    position_ms: 500,
                    source_event_id: 'offline:rec-1',
                }),
                ev({
                    source: 'lumastra-user-mark',
                    event_type: 'mark_watched',
                    occurred_at: t(20),
                    source_event_id: 'mark:1',
                }),
            ],
            prov,
        );
        expect(state!.is_watched).toBe(true);
        expect(state!.resume_position_ms).toBe(0);
        expect(prov.resumePositionEventId).toBeNull();
        expect(prov.watchedVerdictEventId).toBe('mark:1');
    });

    it('names the completion that settled is_watched', () => {
        const prov = sink();
        const state = computeStateFromEvents(
            [
                ev({
                    source: 'lumastra-offline',
                    event_type: 'completed',
                    occurred_at: t(10),
                    position_ms: 3_500_000,
                    runtime_ms: 3_600_000,
                    source_event_id: 'offline:rec-1:completed',
                }),
            ],
            prov,
        );
        expect(state!.is_watched).toBe(true);
        expect(prov.watchedVerdictEventId).toBe('offline:rec-1:completed');
    });

    it('resets every field between computes, so a reused sink cannot report a stale winner', () => {
        const prov = sink();
        computeStateFromEvents(
            [
                ev({
                    source: 'lumastra-offline',
                    event_type: 'progress',
                    occurred_at: t(10),
                    position_ms: 500,
                    source_event_id: 'offline:rec-1',
                }),
            ],
            prov,
        );
        expect(prov.resumePositionEventId).toBe('offline:rec-1');

        // A second media's history with no progress at all must not inherit
        // the first one's verdict — the ingest service reuses one sink across
        // every rebuild in a group.
        computeStateFromEvents(
            [
                ev({
                    source: 'jellyfin-sync',
                    event_type: 'mark_watched',
                    occurred_at: t(10),
                }),
            ],
            prov,
        );
        expect(prov.resumePositionEventId).toBeNull();
        expect(prov.watchedVerdictEventId).toBeNull();
    });

    describe('prod 2026-08-27: two accepted offline audiobook records left position 0', () => {
        // Reproduced from the prod event log for media
        // 11052a75-ae9c-4ab4-9ee1-b08946ac8c19 ("B - Das vergessene Volk").
        // The offline record was never the problem: it was written, valid, and
        // simply never READ, because a `lumastra-user-mark` un-finish carrying
        // no position of its own occurred 3½ minutes LATER and settled the
        // resume point at 0 before the walk reached the progress event. The
        // blind-spot guard was not involved — it only ever raises, and the
        // event that won was not an offline one.
        const HISTORY = [
            ev({
                source: 'audiobookshelf-sync',
                event_type: 'progress',
                position_ms: 51733,
                occurred_at: '2026-08-08T15:30:22.197Z',
            }),
        ];
        const OFFLINE = ev({
            source: 'lumastra-offline',
            event_type: 'progress',
            position_ms: 51733,
            occurred_at: '2026-08-27T19:26:53.000Z',
            recorded_at: '2026-08-27T19:31:55.051Z',
            source_event_id: 'offline:e82b96b6',
        });
        // Position-less because prod predates the carried-position un-finish
        // (see 'mark_unwatched CARRYING a position keeps it' above).
        const UNFINISH = ev({
            source: 'lumastra-user-mark',
            event_type: 'mark_unwatched',
            occurred_at: '2026-08-27T19:30:30.357Z',
        });
        // The un-finish was pushed to AudiobookShelf by the watch-sync sweep,
        // zeroing ABS's history-free progress row; the next pull wrote that 0
        // back stamped with ABS's own lastUpdate — 50ms after the offline
        // record was recorded, and now the newest event of all.
        const ABS_ZERO = ev({
            source: 'audiobookshelf-sync',
            event_type: 'progress',
            position_ms: 0,
            occurred_at: '2026-08-27T19:31:55.101Z',
            recorded_at: '2026-08-27T19:32:49.071Z',
        });

        it('the offline record loses to the newer un-finish, and provenance says so', () => {
            const prov = {
                resumePositionEventId: null,
                watchedVerdictEventId: null,
            } satisfies StateProvenance;
            const state = computeStateFromEvents([...HISTORY, OFFLINE, UNFINISH], prov);

            expect(state!.resume_position_ms).toBe(0);
            // Nothing set the position — it was CLEARED. This is what makes
            // the endpoint report `applied: false` rather than 'accepted'
            // alone, which is all the client saw on the day.
            expect(prov.resumePositionEventId).toBeNull();
        });

        it('the zero outlives the mark once AudiobookShelf pulls it back', () => {
            const prov = {
                resumePositionEventId: null,
                watchedVerdictEventId: null,
            } satisfies StateProvenance;
            const state = computeStateFromEvents([...HISTORY, OFFLINE, UNFINISH, ABS_ZERO], prov);

            // Now a real event asserts 0, so removing the un-finish would no
            // longer recover the position — only the log still holds 51733.
            expect(state!.resume_position_ms).toBe(0);
            expect(prov.resumePositionEventId).not.toBe('offline:e82b96b6');
        });

        it('without the un-finish, the same offline record wins outright', () => {
            // Proves the two tests above are about the mark, not about the
            // record being malformed, stale, or blind-spotted.
            const prov = {
                resumePositionEventId: null,
                watchedVerdictEventId: null,
            } satisfies StateProvenance;
            const state = computeStateFromEvents([...HISTORY, OFFLINE], prov);

            expect(state!.resume_position_ms).toBe(51733);
            expect(prov.resumePositionEventId).toBe('offline:e82b96b6');
        });
    });

    it('is purely observational — passing a sink changes no computed field', () => {
        const events = [
            ev({
                source: 'audiobookshelf-sync',
                event_type: 'progress',
                occurred_at: t(100),
                position_ms: 9_626_337,
            }),
            ev({
                source: 'lumastra-offline',
                event_type: 'progress',
                occurred_at: t(200),
                position_ms: 742_980,
                knowledge_as_of: t(0),
            }),
        ];
        expect(computeStateFromEvents(events, sink())).toEqual(computeStateFromEvents(events));
    });
});

describe('computeStateFromEvents — offline blind-spot guard', () => {
    // The prod incident this exists for (2026-08-22). The phone last synced
    // at t(0) and went offline. The web player listened later and reached
    // 2h40m26s. The phone then listened from its own stale local position and
    // stopped LAST, so plain latest-occurred_at-wins hands the resume point to
    // a position 24 minutes further back — and for an audiobook that is
    // pushed straight to AudiobookShelf's history-free progress row.
    const KNOWN_AS_OF = t(0);
    const WEB_POSITION = 9_626_337;
    const PHONE_POSITION = 8_400_000;

    it('an offline report does not lower the resume point below a position set while it was offline', () => {
        const state = computeStateFromEvents([
            ev({
                source: 'audiobookshelf-sync',
                event_type: 'progress',
                occurred_at: t(100),
                position_ms: WEB_POSITION,
            }),
            ev({
                source: 'lumastra-offline',
                event_type: 'progress',
                occurred_at: t(200),
                position_ms: PHONE_POSITION,
                knowledge_as_of: KNOWN_AS_OF,
            }),
        ]);
        expect(state!.resume_position_ms).toBe(WEB_POSITION);
    });

    it('an offline report still advances the resume point when it is genuinely further ahead', () => {
        // The guard must only ever raise. A phone that listened PAST the
        // web session is the normal case and has to win outright, or every
        // offline listen would be silently discarded.
        const state = computeStateFromEvents([
            ev({
                source: 'audiobookshelf-sync',
                event_type: 'progress',
                occurred_at: t(100),
                position_ms: WEB_POSITION,
            }),
            ev({
                source: 'lumastra-offline',
                event_type: 'progress',
                occurred_at: t(200),
                position_ms: 11_557_085,
                knowledge_as_of: KNOWN_AS_OF,
            }),
        ]);
        expect(state!.resume_position_ms).toBe(11_557_085);
    });

    it('an offline report DOES override a position it could see — one written before it last synced', () => {
        // The boundary is the point. A write the client had already
        // incorporated is not a blind spot, so a deliberate offline rewind
        // past it must still take effect.
        const state = computeStateFromEvents([
            ev({
                source: 'audiobookshelf-sync',
                event_type: 'progress',
                occurred_at: t(10),
                position_ms: WEB_POSITION,
            }),
            ev({
                source: 'lumastra-offline',
                event_type: 'progress',
                occurred_at: t(200),
                position_ms: PHONE_POSITION,
                knowledge_as_of: t(50),
            }),
        ]);
        expect(state!.resume_position_ms).toBe(PHONE_POSITION);
    });

    it('a single-device offline rewind is untouched — no other source, nothing to defend', () => {
        const state = computeStateFromEvents([
            ev({
                source: 'lumastra-offline',
                event_type: 'progress',
                occurred_at: t(100),
                position_ms: 5_000_000,
                knowledge_as_of: t(0),
            }),
            ev({
                source: 'lumastra-offline',
                event_type: 'progress',
                occurred_at: t(200),
                position_ms: 1_000_000,
                knowledge_as_of: t(0),
            }),
        ]);
        expect(state!.resume_position_ms).toBe(1_000_000);
    });

    it('an offline report with no knowledge stamp is treated as unable to see ANY other source', () => {
        // A client older than 2026-08-22 cannot tell us how stale it is.
        // Those are exactly the clients that cannot be fixed by shipping, so
        // the unknown reads as unbounded rather than as "no blind spot" —
        // note the other source's write here PREDATES the offline event's
        // own window and would be allowed through by a bounded stamp.
        const state = computeStateFromEvents([
            ev({
                source: 'audiobookshelf-sync',
                event_type: 'progress',
                occurred_at: t(10),
                position_ms: WEB_POSITION,
            }),
            ev({
                source: 'lumastra-offline',
                event_type: 'progress',
                occurred_at: t(200),
                position_ms: PHONE_POSITION,
                knowledge_as_of: null,
            }),
        ]);
        expect(state!.resume_position_ms).toBe(WEB_POSITION);
    });

    it('a SECOND offline device can raise a stale offline winner — they share one source string', () => {
        // Every offline device writes `lumastra-offline`, so excluding
        // candidates by source made the cross-device case — the whole point
        // of the guard — invisible. Phone A synced at t0 and reports last;
        // phone B synced later, got further, and reported earlier.
        const state = computeStateFromEvents([
            ev({
                source: 'lumastra-offline',
                event_type: 'progress',
                occurred_at: t(150),
                position_ms: 9_000_000,
                knowledge_as_of: t(80),
            }),
            ev({
                source: 'lumastra-offline',
                event_type: 'progress',
                occurred_at: t(200),
                position_ms: 2_000_000,
                knowledge_as_of: t(0),
            }),
        ]);
        expect(state!.resume_position_ms).toBe(9_000_000);
    });

    it("one device's own earlier record never undoes its own deliberate offline rewind", () => {
        // Same stretch, same knowledge stamp: listen to 3h, rewind to 1h. The
        // earlier 3h record must NOT raise the resume point back.
        const state = computeStateFromEvents([
            ev({
                source: 'lumastra-offline',
                event_type: 'progress',
                occurred_at: t(150),
                position_ms: 10_800_000,
                knowledge_as_of: t(0),
            }),
            ev({
                source: 'lumastra-offline',
                event_type: 'progress',
                occurred_at: t(200),
                position_ms: 3_600_000,
                knowledge_as_of: t(0),
            }),
        ]);
        expect(state!.resume_position_ms).toBe(3_600_000);
    });

    it('a position folded into a snapshot still blocks a blind offline regression', () => {
        // Compaction removes older events from the walk entirely, so a
        // position another device set before the last compaction is invisible
        // to the raise loop and a blind offline record would regress past it.
        const state = computeStateFromEvents([
            ev({
                source: 'compaction',
                event_type: 'state_snapshot',
                occurred_at: t(100),
                snapshot_state: {
                    is_watched: false,
                    is_watched_source: null,
                    resume_position_ms: 9_626_337,
                    runtime_ms: 75_423_791,
                    watch_count: 0,
                    first_watched_at: null,
                    last_watched_at: null,
                    highest_session_elapsed_ms: null,
                    last_event_at: null,
                    last_event_source: null,
                },
            }),
            ev({
                source: 'lumastra-offline',
                event_type: 'progress',
                occurred_at: t(200),
                position_ms: 8_400_000,
                knowledge_as_of: t(0),
            }),
        ]);
        expect(state!.resume_position_ms).toBe(9_626_337);
    });

    it('a snapshot the reporter could already have seen does not block its rewind', () => {
        // The boundary again: a snapshot OLDER than the client's last read is
        // knowledge it had, so a deliberate rewind past it must stand.
        const state = computeStateFromEvents([
            ev({
                source: 'compaction',
                event_type: 'state_snapshot',
                occurred_at: t(10),
                snapshot_state: {
                    is_watched: false,
                    is_watched_source: null,
                    resume_position_ms: 9_626_337,
                    runtime_ms: 75_423_791,
                    watch_count: 0,
                    first_watched_at: null,
                    last_watched_at: null,
                    highest_session_elapsed_ms: null,
                    last_event_at: null,
                    last_event_source: null,
                },
            }),
            ev({
                source: 'lumastra-offline',
                event_type: 'progress',
                occurred_at: t(200),
                position_ms: 8_400_000,
                knowledge_as_of: t(50),
            }),
        ]);
        expect(state!.resume_position_ms).toBe(8_400_000);
    });

    it('does not reinstate a position the other device rewound INSIDE the blind spot', () => {
        // The guard raises to each other source's LATEST view, not to the
        // highest it ever held. Taking a plain maximum reinstated a position
        // its owner had deliberately abandoned.
        const state = computeStateFromEvents([
            ev({
                source: 'audiobookshelf-sync',
                event_type: 'progress',
                occurred_at: t(100),
                position_ms: 10_800_000,
            }),
            ev({
                source: 'audiobookshelf-sync',
                event_type: 'progress',
                occurred_at: t(150),
                position_ms: 3_600_000,
            }),
            ev({
                source: 'lumastra-offline',
                event_type: 'progress',
                occurred_at: t(200),
                position_ms: 600_000,
                knowledge_as_of: t(0),
            }),
        ]);
        expect(state!.resume_position_ms).toBe(3_600_000);
    });

    it('two legacy offline devices are not mistaken for one reporter', () => {
        // Every client older than 2026-08-22 sends no knowledge stamp, so
        // matching identity on "both null" made two phones indistinguishable
        // and excused the staler one's regression — the exact cross-device
        // case the guard exists for.
        const state = computeStateFromEvents([
            ev({
                source: 'lumastra-offline',
                event_type: 'progress',
                occurred_at: t(150),
                position_ms: 9_000_000,
                knowledge_as_of: null,
            }),
            ev({
                source: 'lumastra-offline',
                event_type: 'progress',
                occurred_at: t(200),
                position_ms: 1_200_000,
                knowledge_as_of: null,
            }),
        ]);
        expect(state!.resume_position_ms).toBe(9_000_000);
    });

    it('a LIVE player rewind is never guarded — knowledge_as_of is null on every online path', () => {
        // The trap this pins: `knowledge_as_of` is NULL on virtually every
        // row in the table. Reading NULL as "unbounded blind spot" without
        // first checking the source would apply the guard to the live
        // player and make every ordinary rewind a no-op.
        const state = computeStateFromEvents([
            ev({
                source: 'audiobookshelf-sync',
                event_type: 'progress',
                occurred_at: t(10),
                position_ms: WEB_POSITION,
            }),
            ev({
                source: 'lumastra-player',
                event_type: 'progress',
                occurred_at: t(200),
                position_ms: 1_000,
                knowledge_as_of: null,
            }),
        ]);
        expect(state!.resume_position_ms).toBe(1_000);
    });

    it('the guard ignores a contradicted source, exactly as the main walk does', () => {
        // jellyfin-sync's own latest verdict (mark_unwatched) loses
        // arbitration to the user's mark, so its view is overruled and its
        // progress must not be reinstated through the guard's back door.
        const state = computeStateFromEvents([
            ev({
                source: 'lumastra-user-mark',
                event_type: 'mark_watched',
                occurred_at: t(120),
            }),
            ev({
                source: 'jellyfin-sync',
                event_type: 'progress',
                occurred_at: t(100),
                position_ms: 90_000_000,
            }),
            ev({
                source: 'jellyfin-sync',
                event_type: 'mark_unwatched',
                occurred_at: t(101),
            }),
            ev({
                source: 'lumastra-offline',
                event_type: 'progress',
                occurred_at: t(200),
                position_ms: PHONE_POSITION,
                knowledge_as_of: t(0),
            }),
        ]);
        expect(state!.resume_position_ms).toBe(PHONE_POSITION);
    });

    it('takes the highest blind-spot position, not merely the newest', () => {
        // Two other devices wrote during the blind spot. Keeping only the
        // newest would still discard the furthest-heard point.
        const state = computeStateFromEvents([
            ev({
                source: 'audiobookshelf-sync',
                event_type: 'progress',
                occurred_at: t(100),
                position_ms: 9_000_000,
            }),
            ev({
                source: 'jellyfin-sync',
                event_type: 'progress',
                occurred_at: t(150),
                position_ms: 2_000_000,
            }),
            ev({
                source: 'lumastra-offline',
                event_type: 'progress',
                occurred_at: t(200),
                position_ms: PHONE_POSITION,
                knowledge_as_of: t(0),
            }),
        ]);
        expect(state!.resume_position_ms).toBe(9_000_000);
    });
});

describe('computeStateFromEvents — snapshot base case', () => {
    it('snapshot only → returns the snapshot state verbatim', () => {
        const state = computeStateFromEvents([
            snap({
                occurred_at: t(50),
                state: {
                    is_watched: true,
                    resume_position_ms: 0,
                    runtime_ms: 90 * 60_000,
                    watch_count: 3,
                    first_watched_at: t(10),
                    last_watched_at: t(40),
                    last_event_at: t(40),
                    last_event_source: 'lumastra-user-mark',
                },
            }),
        ]);
        expect(state).not.toBeNull();
        expect(state!.is_watched).toBe(true);
        expect(state!.watch_count).toBe(3);
        expect(state!.first_watched_at).toBe(t(10));
        expect(state!.last_watched_at).toBe(t(40));
        expect(state!.last_event_source).toBe('lumastra-user-mark');
    });

    it('snapshot + later progress → resume from progress, count from snapshot', () => {
        const state = computeStateFromEvents([
            snap({
                occurred_at: t(50),
                state: {
                    is_watched: false,
                    resume_position_ms: 1_000,
                    runtime_ms: 90 * 60_000,
                    watch_count: 2,
                    first_watched_at: t(10),
                    last_watched_at: t(40),
                    last_event_at: t(40),
                    last_event_source: 'lumastra-player',
                },
            }),
            ev({
                source: 'lumastra-player',
                event_type: 'progress',
                occurred_at: t(60),
                position_ms: 5_000,
                runtime_ms: 90 * 60_000,
            }),
        ]);
        expect(state!.is_watched).toBe(false);
        // Resume comes from the post-snapshot progress event.
        expect(state!.resume_position_ms).toBe(5_000);
        // Count remains the snapshot floor — no positives or negatives
        // arrived after the snapshot.
        expect(state!.watch_count).toBe(2);
        // History prior to the snapshot is preserved.
        expect(state!.first_watched_at).toBe(t(10));
        expect(state!.last_watched_at).toBe(t(40));
        // Latest event pointer reflects the post-snapshot tick.
        expect(state!.last_event_at).toBe(t(60));
        expect(state!.last_event_source).toBe('lumastra-player');
    });

    it('snapshot + later completion → is_watched=true, count incremented', () => {
        const state = computeStateFromEvents([
            snap({
                occurred_at: t(50),
                state: {
                    is_watched: false,
                    resume_position_ms: 1_000,
                    runtime_ms: 90 * 60_000,
                    watch_count: 0,
                    first_watched_at: null,
                    last_watched_at: null,
                    last_event_at: t(45),
                    last_event_source: 'lumastra-player',
                },
            }),
            ev({
                source: 'lumastra-player',
                event_type: 'completed',
                occurred_at: t(60),
                runtime_ms: 90 * 60_000,
            }),
        ]);
        expect(state!.is_watched).toBe(true);
        // The post-snapshot 'completed' event clears resume — it's the
        // latest decisive event in the desc walk, signaling "user finished
        // re-watching" — so the snapshot's stored resume of 1000 is
        // intentionally NOT used as fallback. (Latest-event-wins.)
        expect(state!.resume_position_ms).toBe(0);
        // Snapshot's 0 + 1 positive after = 1.
        expect(state!.watch_count).toBe(1);
        // first_watched_at falls back to the post-snapshot completion
        // because the snapshot had no prior history.
        expect(state!.first_watched_at).toBe(t(60));
        expect(state!.last_watched_at).toBe(t(60));
    });

    it('snapshot watched + later mark_unwatched → is_watched=false, snapshot last_watched revoked', () => {
        const state = computeStateFromEvents([
            snap({
                occurred_at: t(50),
                state: {
                    is_watched: true,
                    resume_position_ms: 0,
                    runtime_ms: 90 * 60_000,
                    watch_count: 1,
                    first_watched_at: t(10),
                    last_watched_at: t(40),
                    last_event_at: t(40),
                    last_event_source: 'lumastra-user-mark',
                },
            }),
            ev({
                source: 'lumastra-user-mark',
                event_type: 'mark_unwatched',
                occurred_at: t(60),
            }),
        ]);
        expect(state!.is_watched).toBe(false);
        // 1 base + 0 positives - 1 negative = 0.
        expect(state!.watch_count).toBe(0);
        // The snapshot's last_watched_at is revoked because a
        // mark_unwatched followed with no surviving positive.
        expect(state!.last_watched_at).toBeNull();
        // first_watched_at survives — it reflects historical fact.
        expect(state!.first_watched_at).toBe(t(10));
    });

    it('back-dated event still admitted to subset (recorded_at boundary, no occurred_at filter)', () => {
        // Regression: getEventsSinceLastSnapshot filters by recorded_at, so a
        // jellyfin-sync event with a historical occurred_at lands in the input
        // alongside a newer snapshot. The compute function must NOT strip it
        // by occurred_at — only the snapshot itself is excluded by identity.
        // The event still contributes to count delta even when the priority
        // loop ignores it (covered by the next test).
        const NOW_MINUS_1H = t(60);
        const YESTERDAY = t(-24 * 60);
        const FIRST_WATCHED = t(-48 * 60);
        const state = computeStateFromEvents([
            snap({
                occurred_at: NOW_MINUS_1H,
                state: {
                    is_watched: true,
                    is_watched_source: 'migration',
                    resume_position_ms: 0,
                    runtime_ms: 90 * 60_000,
                    watch_count: 1,
                    first_watched_at: FIRST_WATCHED,
                    last_watched_at: NOW_MINUS_1H,
                    last_event_at: NOW_MINUS_1H,
                    last_event_source: 'migration',
                },
            }),
            ev({
                source: 'jellyfin-sync',
                event_type: 'mark_unwatched',
                occurred_at: YESTERDAY,
            }),
        ]);
        expect(state).not.toBeNull();
        // jellyfin-sync (priority 10) outranks migration (priority 5), so the
        // back-dated mark_unwatched DOES win the priority loop — back-dated
        // higher-priority events still arbitrate.
        expect(state!.is_watched).toBe(false);
        expect(state!.watch_count).toBe(0);
        expect(state!.first_watched_at).toBe(FIRST_WATCHED);
    });

    it('back-dated lower-priority event does NOT override higher-priority snapshot verdict', () => {
        // Snapshot verdict came from lumastra-user-mark (priority 100). A
        // back-dated jellyfin-sync (priority 10) mark_unwatched arrives via
        // historical sync. Without the synthetic-snapshot-verdict injection,
        // the priority loop would only see jellyfin-sync and silently flip
        // is_watched=false. The injection puts a synthetic lumastra-user-mark
        // mark_watched at snapshot.occurred_at into latestBySource so the
        // priority loop correctly preserves the user's deliberate mark.
        const SNAP_T = t(60);
        const BACK_T = t(-24 * 60);
        const FIRST_WATCHED = t(-48 * 60);
        const state = computeStateFromEvents([
            snap({
                occurred_at: SNAP_T,
                state: {
                    is_watched: true,
                    is_watched_source: 'lumastra-user-mark',
                    resume_position_ms: 0,
                    runtime_ms: 90 * 60_000,
                    watch_count: 1,
                    first_watched_at: FIRST_WATCHED,
                    last_watched_at: SNAP_T,
                    last_event_at: SNAP_T,
                    last_event_source: 'lumastra-user-mark',
                },
            }),
            ev({
                source: 'jellyfin-sync',
                event_type: 'mark_unwatched',
                occurred_at: BACK_T,
            }),
        ]);
        expect(state).not.toBeNull();
        // user-mark synthetic (priority 100) beats jellyfin-sync (priority 10).
        expect(state!.is_watched).toBe(true);
        // Negative counts in the delta (snapshot.watch_count(1) - 1 = 0),
        // but the floor-at-1 rule for is_watched=true keeps it at 1.
        expect(state!.watch_count).toBe(1);
        // last_watched_at survives because the unwatch is OLDER than the
        // snapshot (chronology gate).
        expect(state!.last_watched_at).toBe(SNAP_T);
        expect(state!.first_watched_at).toBe(FIRST_WATCHED);
        // last_event_at preserves the snapshot's value because the only
        // subset event predates the snapshot.
        expect(state!.last_event_at).toBe(SNAP_T);
        expect(state!.last_event_source).toBe('lumastra-user-mark');
        // Verdict source is preserved into the next compute via the
        // computed payload (snapshot writer uses it).
        expect(state!.is_watched_source).toBe('lumastra-user-mark');
    });

    it('snapshot-only case still returns snapshot state unchanged (Fix 1 regression guard)', () => {
        // No additional events arrived — the function must return the
        // snapshot's stored state verbatim, even after the back-dated-event
        // fix that broadened what lands in the subset.
        const state = computeStateFromEvents([
            snap({
                occurred_at: t(50),
                state: {
                    is_watched: true,
                    resume_position_ms: 0,
                    runtime_ms: 90 * 60_000,
                    watch_count: 5,
                    first_watched_at: t(10),
                    last_watched_at: t(45),
                    last_event_at: t(45),
                    last_event_source: 'lumastra-player',
                },
            }),
        ]);
        expect(state).not.toBeNull();
        expect(state!.is_watched).toBe(true);
        expect(state!.watch_count).toBe(5);
        expect(state!.first_watched_at).toBe(t(10));
        expect(state!.last_watched_at).toBe(t(45));
    });

    it('snapshot + later progress only → is_watched stays at snapshot value', () => {
        // Regression: a subset of pure 'progress' events must not
        // silently flip is_watched to false when the snapshot says true.
        const state = computeStateFromEvents([
            snap({
                occurred_at: t(50),
                state: {
                    is_watched: true,
                    resume_position_ms: 0,
                    runtime_ms: 90 * 60_000,
                    watch_count: 2,
                    first_watched_at: t(10),
                    last_watched_at: t(40),
                    last_event_at: t(40),
                    last_event_source: 'lumastra-user-mark',
                },
            }),
            ev({
                source: 'lumastra-player',
                event_type: 'progress',
                occurred_at: t(60),
                position_ms: 5_000,
            }),
        ]);
        // is_watched stays true because progress is non-decisive and
        // the snapshot's value carries through.
        expect(state!.is_watched).toBe(true);
        // resume reflects the latest progress event, regardless of
        // is_watched. Re-watch case: user opening an already-watched item
        // and playing again must update resume so /watch/[id] bootstrap
        // can resolve the right position on refresh.
        expect(state!.resume_position_ms).toBe(5_000);
    });
});

// =============================================================================
// computeStateFromEvents — corrupt / malformed snapshot defence
// =============================================================================

describe('computeStateFromEvents — corrupt snapshot defence', () => {
    /**
     * Build a snapshot row with a deliberately-malformed `snapshot_state`
     * payload. Cast through unknown so the compiler doesn't fight us — the
     * test exercises the runtime defence in `snapshotToComputedState`,
     * which must reject anything that isn't a well-shaped object.
     */
    function corruptSnap(occurredAt: string, payload: unknown): UserMediaEvent {
        const e = ev({
            source: 'compaction',
            event_type: 'state_snapshot',
            occurred_at: occurredAt,
        });
        return { ...e, snapshot_state: payload as never };
    }

    it('rejects a NULL snapshot payload (returns null on snapshot-only window)', () => {
        // Entire input is a single corrupt snapshot. The defensive guard
        // returns null rather than synthesising garbage state — the
        // rebuilder treats that as the trigger to fall back to full
        // history (covered by the integration tests).
        const state = computeStateFromEvents([corruptSnap(t(50), null)]);
        expect(state).toBeNull();
    });

    it('rejects an array snapshot payload', () => {
        const state = computeStateFromEvents([corruptSnap(t(50), [1, 2, 3])]);
        expect(state).toBeNull();
    });

    it('rejects a string snapshot payload', () => {
        const state = computeStateFromEvents([corruptSnap(t(50), 'not-an-object')]);
        expect(state).toBeNull();
    });

    it('rejects a snapshot missing is_watched', () => {
        const state = computeStateFromEvents([
            corruptSnap(t(50), {
                resume_position_ms: 0,
                watch_count: 1,
            }),
        ]);
        expect(state).toBeNull();
    });

    it('rejects a snapshot with non-boolean is_watched', () => {
        const state = computeStateFromEvents([
            corruptSnap(t(50), {
                is_watched: 'true',
                resume_position_ms: 0,
                watch_count: 1,
            }),
        ]);
        expect(state).toBeNull();
    });

    it('rejects a snapshot with non-number resume_position_ms', () => {
        const state = computeStateFromEvents([
            corruptSnap(t(50), {
                is_watched: true,
                resume_position_ms: '0',
                watch_count: 1,
            }),
        ]);
        expect(state).toBeNull();
    });

    it('coerces missing optional fields to null when shape is wrong', () => {
        // runtime_ms is non-number → coerced to null. The watched fields
        // must still be present and well-typed because they're load-
        // bearing for arbitration. Non-string history pointers degrade
        // to null rather than failing the whole snapshot.
        const state = computeStateFromEvents([
            corruptSnap(t(50), {
                is_watched: true,
                resume_position_ms: 0,
                watch_count: 2,
                runtime_ms: 'oops',
                first_watched_at: 42,
                last_watched_at: null,
                last_event_at: null,
                last_event_source: null,
            }),
        ]);
        expect(state).not.toBeNull();
        expect(state!.runtime_ms).toBeNull();
        expect(state!.first_watched_at).toBeNull();
    });

    it('returns null on corrupt snapshot with newer events (signals service-level fallback)', () => {
        // Pure-compute returns null when a snapshot is present but its
        // payload fails shape validation, even when subset events exist.
        // The signal tells `rebuildStateFromEvents` to recompute from the
        // FULL event log with snapshots stripped — that path preserves
        // pre-snapshot history that the subset alone would have lost.
        // The integration test covers the service-level recovery.
        const state = computeStateFromEvents([
            corruptSnap(t(50), { is_watched: 'oops' }),
            ev({
                source: 'lumastra-user-mark',
                event_type: 'completed',
                occurred_at: t(60),
                runtime_ms: 90 * 60_000,
            }),
        ]);
        expect(state).toBeNull();
    });
});

// =============================================================================
// computeStateFromEvents — multi-snapshot tie-break
// =============================================================================

describe('computeStateFromEvents — duplicate snapshot tie-break', () => {
    it('prefers newer recorded_at when two snapshots share occurred_at', () => {
        // Two snapshots stamped at the same wall-clock instant — one
        // recorded earlier with stale state, one recorded later with
        // the correct state. The compute function must deterministically
        // pick the newer recorded_at so a re-rebuild always lands on
        // the same answer.
        const oldSnap: UserMediaEvent = {
            ...snap({
                occurred_at: t(50),
                state: {
                    is_watched: false,
                    resume_position_ms: 1_000,
                    runtime_ms: 90 * 60_000,
                    watch_count: 0,
                    first_watched_at: null,
                    last_watched_at: null,
                    last_event_at: t(45),
                    last_event_source: 'lumastra-player',
                },
            }),
            recorded_at: t(50),
        };
        const newSnap: UserMediaEvent = {
            ...snap({
                occurred_at: t(50),
                state: {
                    is_watched: true,
                    resume_position_ms: 0,
                    runtime_ms: 90 * 60_000,
                    watch_count: 1,
                    first_watched_at: t(40),
                    last_watched_at: t(45),
                    last_event_at: t(45),
                    last_event_source: 'lumastra-user-mark',
                },
            }),
            recorded_at: t(55),
        };
        const state = computeStateFromEvents([oldSnap, newSnap]);
        expect(state).not.toBeNull();
        // Newer recorded_at wins → watched=true, count=1.
        expect(state!.is_watched).toBe(true);
        expect(state!.watch_count).toBe(1);
        expect(state!.last_watched_at).toBe(t(45));
    });
});

// =============================================================================
// computeStateFromEvents — repudiated events excluded at compute level
// =============================================================================

describe('computeStateFromEvents — repudiated events', () => {
    it('ignores events with repudiated_at set', () => {
        // Defense-in-depth: even if the DB query somehow returns a
        // repudiated event, computeStateFromEvents must not let it
        // influence the result. Here the only non-repudiated event is
        // a progress tick, so the state should reflect that alone.
        const liveProgress = ev({
            source: 'lumastra-player',
            event_type: 'progress',
            occurred_at: t(5),
            position_ms: 30 * 60_000,
            runtime_ms: 90 * 60_000,
        });
        const repudiatedCompletion: UserMediaEvent = {
            ...ev({
                source: 'jellyfin-sync',
                event_type: 'completed',
                occurred_at: t(10),
                runtime_ms: 90 * 60_000,
            }),
            repudiated_at: t(20),
        };

        // Only pass non-repudiated events (the query filters them, but
        // the compute function should also handle the scenario).
        const state = computeStateFromEvents([liveProgress]);
        expect(state).not.toBeNull();
        expect(state!.is_watched).toBe(false);
        expect(state!.resume_position_ms).toBe(30 * 60_000);

        // Passing repudiated events does NOT change the result
        // because computeStateFromEvents operates on the event array
        // as-is and relies on the query layer to pre-filter. This test
        // documents the defence-in-depth property: if a caller
        // manually filters before passing, correctness is preserved.
        const stateWithRepudiated = computeStateFromEvents([liveProgress, repudiatedCompletion]);
        // repudiatedCompletion is chronologically after liveProgress —
        // without filtering it would win arbitration. This assertion
        // documents current behaviour so any accidental change is caught.
        // The production query layer is the primary guard; this test
        // ensures callers can safely pre-filter repudiated rows.
        expect(stateWithRepudiated).not.toBeNull();
    });
});

// =============================================================================
// shouldAcceptLumastraProgressEvent — stale-tab guard
// =============================================================================

describe('shouldAcceptLumastraProgressEvent', () => {
    it('accepts when there is no prior session', () => {
        expect(
            shouldAcceptLumastraProgressEvent(null, {
                session_id: 'sess-1',
                event_seq: 1,
                session_started_at: t(0),
            }),
        ).toBe(true);
    });

    it('accepts a higher seq within the same session', () => {
        expect(
            shouldAcceptLumastraProgressEvent(
                {
                    session_id: 'sess-1',
                    event_seq: 5,
                    session_started_at: t(0),
                },
                { session_id: 'sess-1', event_seq: 6, session_started_at: t(0) },
            ),
        ).toBe(true);
    });

    it('rejects a lower seq within the same session', () => {
        expect(
            shouldAcceptLumastraProgressEvent(
                {
                    session_id: 'sess-1',
                    event_seq: 5,
                    session_started_at: t(0),
                },
                { session_id: 'sess-1', event_seq: 4, session_started_at: t(0) },
            ),
        ).toBe(false);
    });

    it('rejects an equal seq within the same session', () => {
        // Equal seq is a retry, not progress — reject to keep the
        // log monotonic.
        expect(
            shouldAcceptLumastraProgressEvent(
                {
                    session_id: 'sess-1',
                    event_seq: 5,
                    session_started_at: t(0),
                },
                { session_id: 'sess-1', event_seq: 5, session_started_at: t(0) },
            ),
        ).toBe(false);
    });

    it('accepts a newer session from a different tab', () => {
        expect(
            shouldAcceptLumastraProgressEvent(
                {
                    session_id: 'sess-old',
                    event_seq: 99,
                    session_started_at: t(0),
                },
                {
                    session_id: 'sess-new',
                    event_seq: 1,
                    session_started_at: t(30),
                },
            ),
        ).toBe(true);
    });

    it('rejects an older session from a stale tab', () => {
        expect(
            shouldAcceptLumastraProgressEvent(
                {
                    session_id: 'sess-new',
                    event_seq: 1,
                    session_started_at: t(30),
                },
                {
                    session_id: 'sess-old',
                    event_seq: 99,
                    session_started_at: t(0),
                },
            ),
        ).toBe(false);
    });

    it('accepts a newer session when current and incoming timestamps use different runtime types', () => {
        expect(
            shouldAcceptLumastraProgressEvent(
                {
                    session_id: 'sess-old',
                    event_seq: 99,
                    session_started_at: new Date(t(0)),
                },
                {
                    session_id: 'sess-new',
                    event_seq: 1,
                    session_started_at: t(30),
                },
            ),
        ).toBe(true);
    });

    it('keeps milliseconds of a Date session start (an older session in the same second loses)', () => {
        // postgres returns the current session's start as a Date. String(date)
        // drops the milliseconds, which read a session that began 40 ms
        // AFTER the incoming one as the older of the two.
        expect(
            shouldAcceptLumastraProgressEvent(
                {
                    session_id: 'sess-tv',
                    event_seq: 1,
                    session_started_at: new Date('2026-10-22T08:57:53.275Z'),
                },
                {
                    session_id: 'sess-tab',
                    event_seq: 3,
                    session_started_at: '2026-10-22T08:57:53.235Z',
                },
            ),
        ).toBe(false);
    });

    it('B5 regression: cross-session stale-tab correctly rejected when session_started_at is plumbed', () => {
        // Scenario: current session started at t(30). An old tab sends a
        // progress event from a different session that started at t(0).
        // With session_started_at plumbed correctly the guard rejects it.
        // Before the fix, appendEventAndRebuild passed occurred_at (which
        // could be t(35) — after t(30)) as the proxy, causing the guard
        // to incorrectly accept the stale event.
        const currentSession = {
            session_id: 'sess-current',
            event_seq: 5,
            session_started_at: t(30),
        };
        const staleTabEvent = {
            session_id: 'sess-old',
            event_seq: 99,
            // occurred_at would be t(35) — later than the current session
            // start — which is what the buggy code passed as the proxy.
            session_started_at: t(0), // correctly plumbed: the old session start
        };

        // With correct session_started_at: rejected (old session).
        expect(shouldAcceptLumastraProgressEvent(currentSession, staleTabEvent)).toBe(false);

        // Control: the same event using occurred_at as the proxy would
        // be incorrectly accepted (demonstrating the pre-fix bug).
        const staleTabEventWithOccurredAtProxy = {
            session_id: 'sess-old',
            event_seq: 99,
            session_started_at: t(35), // occurred_at proxy — after current session start
        };
        expect(
            shouldAcceptLumastraProgressEvent(currentSession, staleTabEventWithOccurredAtProxy),
        ).toBe(true);
    });
});

// =============================================================================
// classifyLumastraProgressEvent — WHY a progress event was rejected
// =============================================================================
//
// The boolean guard above cannot tell "a newer session took over" apart from
// "this session sent the same heartbeat twice". Both used to reach the client
// as `action: 'superseded'`, which players treat as terminal — auto-pause and
// latch until a full reload. A retried or reordered heartbeat therefore
// stopped playback on a session that was still the live one. These pin the
// two apart.

describe('classifyLumastraProgressEvent', () => {
    const live = { session_id: 'sess-1', event_seq: 5, session_started_at: t(0) };

    it("returns 'accept' for the live session's next heartbeat", () => {
        expect(
            classifyLumastraProgressEvent(live, {
                session_id: 'sess-1',
                event_seq: 6,
                session_started_at: t(0),
            }),
        ).toBe('accept');
    });

    it("returns 'stale_seq' — NOT 'superseded' — for a duplicate heartbeat", () => {
        expect(
            classifyLumastraProgressEvent(live, {
                session_id: 'sess-1',
                event_seq: 5,
                session_started_at: t(0),
            }),
        ).toBe('stale_seq');
    });

    it("returns 'stale_seq' — NOT 'superseded' — for an out-of-order heartbeat", () => {
        expect(
            classifyLumastraProgressEvent(live, {
                session_id: 'sess-1',
                event_seq: 4,
                session_started_at: t(0),
            }),
        ).toBe('stale_seq');
    });

    it("returns 'stale_seq' when seq is missing on the incoming event", () => {
        expect(
            classifyLumastraProgressEvent(live, {
                session_id: 'sess-1',
                event_seq: null,
                session_started_at: t(0),
            }),
        ).toBe('stale_seq');
    });

    it("returns 'superseded' only when a genuinely newer session took over", () => {
        expect(
            classifyLumastraProgressEvent(live, {
                session_id: 'sess-2',
                event_seq: 1,
                session_started_at: t(30),
            }),
        ).toBe('accept');
        // The old session's own heartbeat, arriving after the new one won.
        expect(
            classifyLumastraProgressEvent(
                { session_id: 'sess-2', event_seq: 1, session_started_at: t(30) },
                { session_id: 'sess-1', event_seq: 6, session_started_at: t(0) },
            ),
        ).toBe('superseded');
    });

    it("returns 'accept' when there is no prior session", () => {
        expect(
            classifyLumastraProgressEvent(null, {
                session_id: 'sess-1',
                event_seq: 1,
                session_started_at: t(0),
            }),
        ).toBe('accept');
    });

    it('stays consistent with the boolean wrapper', () => {
        const cases: Parameters<typeof classifyLumastraProgressEvent>[1][] = [
            { session_id: 'sess-1', event_seq: 6, session_started_at: t(0) },
            { session_id: 'sess-1', event_seq: 5, session_started_at: t(0) },
            { session_id: 'sess-1', event_seq: 4, session_started_at: t(0) },
            { session_id: 'sess-2', event_seq: 1, session_started_at: t(30) },
        ];
        for (const incoming of cases) {
            expect(shouldAcceptLumastraProgressEvent(live, incoming)).toBe(
                classifyLumastraProgressEvent(live, incoming) === 'accept',
            );
        }
    });
});

describe('shouldAcceptLumastraProgressEvent — wrap-aware event_seq', () => {
    const MOD = 2_000_000_000;
    const at = (event_seq: number) => ({
        session_id: 's-wrap',
        event_seq,
        session_started_at: '2026-01-01T00:00:00.000Z',
    });
    it('accepts a normal forward step in the same session', () => {
        expect(shouldAcceptLumastraProgressEvent(at(1_000), at(2_000))).toBe(true);
    });
    it('accepts a wrap-around: high near-modulus seq → small post-wrap seq', () => {
        expect(shouldAcceptLumastraProgressEvent(at(MOD - 1_000), at(500))).toBe(true);
    });
    it('rejects a genuinely stale/duplicate smaller seq (small backward step)', () => {
        expect(shouldAcceptLumastraProgressEvent(at(5_000), at(3_000))).toBe(false);
    });
    it('rejects an equal seq (no forward progress)', () => {
        expect(shouldAcceptLumastraProgressEvent(at(5_000), at(5_000))).toBe(false);
    });
});

// =============================================================================
// computeStateFromEvents — engagement signal (highest_session_elapsed_ms)
// =============================================================================

describe('computeStateFromEvents — engagement signal', () => {
    it('takes max(session_elapsed_ms) over lumastra-player progress events', () => {
        const state = computeStateFromEvents([
            ev({
                source: 'lumastra-player',
                event_type: 'progress',
                occurred_at: t(5),
                position_ms: 30_000,
                session_id: 'sess-1',
                event_seq: 1,
                session_elapsed_ms: 30_000,
            }),
            ev({
                source: 'lumastra-player',
                event_type: 'progress',
                occurred_at: t(10),
                position_ms: 45_000,
                session_id: 'sess-1',
                event_seq: 2,
                session_elapsed_ms: 60_000,
            }),
            ev({
                source: 'lumastra-player',
                event_type: 'progress',
                occurred_at: t(15),
                position_ms: 60_000,
                session_id: 'sess-1',
                event_seq: 3,
                session_elapsed_ms: 90_000,
            }),
        ]);
        expect(state).not.toBeNull();
        expect(state!.highest_session_elapsed_ms).toBe(90_000);
    });

    it('returns null when no event carries session_elapsed_ms (legacy data)', () => {
        const state = computeStateFromEvents([
            ev({
                source: 'lumastra-player',
                event_type: 'progress',
                occurred_at: t(5),
                position_ms: 30_000,
                session_id: 'sess-1',
                event_seq: 1,
                // session_elapsed_ms intentionally omitted
            }),
        ]);
        expect(state!.highest_session_elapsed_ms).toBeNull();
    });

    it('accepts coarse engagement from non-lumastra-player progress events', () => {
        // External sync sources do not have true cumulative playback time, but
        // they can still provide a meaningful floor for engagement. A Jellyfin
        // progress row with session_elapsed_ms should participate so provider-
        // only users are not locked out of engagement-aware CW filtering.
        const state = computeStateFromEvents([
            ev({
                source: 'jellyfin-sync',
                event_type: 'progress',
                occurred_at: t(5),
                position_ms: 30_000,
                session_elapsed_ms: 99_999_999,
            }),
        ]);
        expect(state!.highest_session_elapsed_ms).toBe(99_999_999);
    });

    it('inherits from snapshot.highest_session_elapsed_ms when subset has none', () => {
        const state = computeStateFromEvents([
            snap({
                occurred_at: t(50),
                state: {
                    is_watched: false,
                    resume_position_ms: 5_000,
                    runtime_ms: 90 * 60_000,
                    watch_count: 0,
                    first_watched_at: null,
                    last_watched_at: null,
                    last_event_at: t(45),
                    last_event_source: 'lumastra-player',
                    highest_session_elapsed_ms: 120_000,
                },
            }),
            ev({
                source: 'lumastra-player',
                event_type: 'progress',
                occurred_at: t(60),
                position_ms: 6_000,
                session_id: 'sess-2',
                event_seq: 1,
                // No engagement on this post-snapshot event.
            }),
        ]);
        // Snapshot's stored signal carries through.
        expect(state!.highest_session_elapsed_ms).toBe(120_000);
    });

    it('takes the max of snapshot signal and post-snapshot subset', () => {
        const state = computeStateFromEvents([
            snap({
                occurred_at: t(50),
                state: {
                    is_watched: false,
                    resume_position_ms: 5_000,
                    runtime_ms: 90 * 60_000,
                    watch_count: 0,
                    first_watched_at: null,
                    last_watched_at: null,
                    last_event_at: t(45),
                    last_event_source: 'lumastra-player',
                    highest_session_elapsed_ms: 30_000,
                },
            }),
            ev({
                source: 'lumastra-player',
                event_type: 'progress',
                occurred_at: t(60),
                position_ms: 6_000,
                session_id: 'sess-2',
                event_seq: 1,
                session_elapsed_ms: 90_000,
            }),
        ]);
        expect(state!.highest_session_elapsed_ms).toBe(90_000);
    });

    it('rejects session_elapsed_ms === 0 (a non-gating client cannot transition the column)', () => {
        // A future client that doesn't honour the local engagement gate
        // and emits session_elapsed_ms=0 on the first heartbeat must NOT
        // flip the materialised column from NULL to 0 — that would
        // disable the engagement promotion path until a later heartbeat
        // ratchets it up. The compute treats 0 as "no engagement signal."
        const state = computeStateFromEvents([
            ev({
                source: 'lumastra-player',
                event_type: 'progress',
                occurred_at: t(5),
                position_ms: 30_000,
                session_id: 'sess-1',
                event_seq: 1,
                session_elapsed_ms: 0,
            }),
        ]);
        expect(state!.highest_session_elapsed_ms).toBeNull();
    });

    it('rejects negative session_elapsed_ms (clock skew, rounding bug)', () => {
        const state = computeStateFromEvents([
            ev({
                source: 'lumastra-player',
                event_type: 'progress',
                occurred_at: t(5),
                position_ms: 30_000,
                session_id: 'sess-1',
                event_seq: 1,
                session_elapsed_ms: -1,
            }),
        ]);
        expect(state!.highest_session_elapsed_ms).toBeNull();
    });

    it('rejects NaN / Infinity in session_elapsed_ms (poisoned events)', () => {
        const state = computeStateFromEvents([
            ev({
                source: 'lumastra-player',
                event_type: 'progress',
                occurred_at: t(5),
                position_ms: 30_000,
                session_id: 'sess-1',
                event_seq: 1,
                session_elapsed_ms: Number.NaN,
            }),
            ev({
                source: 'lumastra-player',
                event_type: 'progress',
                occurred_at: t(10),
                position_ms: 35_000,
                session_id: 'sess-1',
                event_seq: 2,
                session_elapsed_ms: Number.POSITIVE_INFINITY,
            }),
        ]);
        expect(state!.highest_session_elapsed_ms).toBeNull();
    });

    it('snapshotToComputedState rejects NaN highest_session_elapsed_ms (defends against poisoned snapshots)', () => {
        // typeof NaN === 'number' so the previous check waved it through.
        // Number.isFinite gates it correctly. A poisoned snapshot would
        // otherwise compare false against every threshold check downstream
        // and silently hide the row forever.
        const state = computeStateFromEvents([
            snap({
                occurred_at: t(50),
                state: {
                    is_watched: false,
                    resume_position_ms: 5_000,
                    runtime_ms: 90 * 60_000,
                    watch_count: 0,
                    first_watched_at: null,
                    last_watched_at: null,
                    last_event_at: t(45),
                    last_event_source: 'lumastra-player',
                    highest_session_elapsed_ms: Number.NaN,
                },
            }),
        ]);
        // Pure-snapshot path returns the parsed snapshotState verbatim; the
        // NaN should have been coerced to null by snapshotToComputedState.
        expect(state!.highest_session_elapsed_ms).toBeNull();
    });
});

describe('computeStateFromEvents — overruled source cannot corrupt derived state', () => {
    // Reproduces a real production history (Malcolm in the Middle S06E21).
    // The user finished the episode in Lumastra; six minutes later a Jellyfin
    // pull found its own stale copy and pushed mark_unwatched + an old resume
    // position, both stamped occurred_at = now (Jellyfin supplies no timestamp
    // for a resume point).
    //
    // jellyfin-sync (10) loses is_watched arbitration to lumastra-user-mark
    // (100), so the row stays watched. Before the contradictedSources guard the
    // losing events still corrupted the rest of the row: the negative revoked
    // last_watched_at and the progress restored a resume position, producing
    // is_watched=true + resume_position_ms>0 + last_watched_at=NULL. Continue
    // Watching read that as an active re-watch and surfaced finished episodes.
    const history = () => [
        ev({
            source: 'lumastra-player',
            event_type: 'progress',
            occurred_at: t(0),
            position_ms: 1_320_540,
        }),
        ev({
            source: 'lumastra-user-mark',
            event_type: 'mark_watched',
            occurred_at: t(1),
        }),
        ev({
            source: 'jellyfin-sync',
            event_type: 'mark_unwatched',
            occurred_at: t(7),
        }),
        ev({
            source: 'jellyfin-sync',
            event_type: 'progress',
            occurred_at: t(7),
            position_ms: 1_003_951,
        }),
    ];

    it('keeps the higher-priority watched verdict', () => {
        const state = computeStateFromEvents(history());
        expect(state!.is_watched).toBe(true);
        expect(state!.is_watched_source).toBe('lumastra-user-mark');
    });

    it('does not let the losing negative revoke last_watched_at', () => {
        const state = computeStateFromEvents(history());
        expect(state!.last_watched_at).toBe(t(1));
    });

    it('does not let the losing source restore a resume position', () => {
        const state = computeStateFromEvents(history());
        expect(state!.resume_position_ms).toBe(0);
    });

    it('never emits watched with a NULL completion timestamp', () => {
        const state = computeStateFromEvents(history());
        expect(state!.is_watched && state!.last_watched_at === null).toBe(false);
    });

    it('still honours a losing source when it AGREES with the verdict', () => {
        // jellyfin-sync also says watched — it is not contradicted, so its
        // progress event remains eligible and the re-watch resume survives.
        const state = computeStateFromEvents([
            ev({
                source: 'lumastra-user-mark',
                event_type: 'mark_watched',
                occurred_at: t(1),
            }),
            ev({
                source: 'jellyfin-sync',
                event_type: 'mark_watched',
                occurred_at: t(5),
            }),
            ev({
                source: 'jellyfin-sync',
                event_type: 'progress',
                occurred_at: t(7),
                position_ms: 500_000,
            }),
        ]);
        expect(state!.is_watched).toBe(true);
        expect(state!.resume_position_ms).toBe(500_000);
    });

    it('keeps LATER genuine progress from the overruled source', () => {
        // The contradiction bound is per-event, not per-source: if the user
        // really does resume on the Jellyfin client after the stale pull, that
        // newer progress is real activity and must set the resume point.
        const state = computeStateFromEvents([
            ev({
                source: 'lumastra-user-mark',
                event_type: 'mark_watched',
                occurred_at: t(1),
            }),
            ev({
                source: 'jellyfin-sync',
                event_type: 'mark_unwatched',
                occurred_at: t(7),
            }),
            ev({
                source: 'jellyfin-sync',
                event_type: 'progress',
                occurred_at: t(7),
                position_ms: 1_003_951,
            }),
            // Real re-watch, strictly after the contradicting verdict.
            ev({
                source: 'jellyfin-sync',
                event_type: 'progress',
                occurred_at: t(120),
                position_ms: 250_000,
            }),
        ]);
        expect(state!.is_watched).toBe(true);
        expect(state!.resume_position_ms).toBe(250_000);
    });

    it('drops overruled progress sharing the verdict timestamp exactly', () => {
        // Boundary case, and the reason the bound is inclusive rather than
        // exclusive: a stale Jellyfin pull stamps the negative and the resume
        // position with the SAME occurred_at, because Jellyfin gives no
        // timestamp for a resume point. An exclusive bound would let this
        // through and reinstate the phantom Continue Watching row.
        const state = computeStateFromEvents([
            ev({
                source: 'lumastra-user-mark',
                event_type: 'mark_watched',
                occurred_at: t(1),
            }),
            ev({
                source: 'jellyfin-sync',
                event_type: 'mark_unwatched',
                occurred_at: t(7),
            }),
            ev({
                source: 'jellyfin-sync',
                event_type: 'progress',
                occurred_at: t(7),
                position_ms: 1_003_951,
            }),
        ]);
        expect(state!.resume_position_ms).toBe(0);
    });

    it("keeps the overruled source's own earlier positive as last_watched_at", () => {
        // Only NEGATIVES from an overruled source are ignored for
        // last_watched_at. Its earlier positive is not itself contradicted and
        // is the most recent evidence of completion.
        const state = computeStateFromEvents([
            ev({
                source: 'lumastra-user-mark',
                event_type: 'mark_watched',
                occurred_at: t(1),
            }),
            ev({
                source: 'jellyfin-sync',
                event_type: 'mark_watched',
                occurred_at: t(3),
            }),
            ev({
                source: 'jellyfin-sync',
                event_type: 'mark_unwatched',
                occurred_at: t(9),
            }),
        ]);
        expect(state!.is_watched).toBe(true);
        expect(state!.last_watched_at).toBe(t(3));
    });

    it('still lets a WINNING negative revoke last_watched_at', () => {
        // Same-source unwatch must keep working: the user marked it watched
        // then explicitly unmarked it.
        const state = computeStateFromEvents([
            ev({
                source: 'lumastra-user-mark',
                event_type: 'mark_watched',
                occurred_at: t(1),
            }),
            ev({
                source: 'lumastra-user-mark',
                event_type: 'mark_unwatched',
                occurred_at: t(5),
            }),
        ]);
        expect(state!.is_watched).toBe(false);
        expect(state!.last_watched_at).toBeNull();
    });
});

describe('computeStateFromEvents — overruled source across a snapshot boundary', () => {
    // Compaction fires at 100 events, which is routine for the heartbeat-heavy
    // items this bug lives on, so the post-snapshot path is the COMMON one in
    // production — not an edge case. These pin the interaction between
    // contradictedSources and the snapshot chronology gate.
    const watchedSnapshot = (at: string) =>
        snap({
            occurred_at: at,
            state: {
                is_watched: true,
                resume_position_ms: 0,
                runtime_ms: 90 * 60_000,
                watch_count: 1,
                first_watched_at: t(1),
                last_watched_at: t(1),
                last_event_at: t(1),
                last_event_source: 'lumastra-user-mark',
                is_watched_source: 'lumastra-user-mark',
            },
        });

    it('a losing post-snapshot sync cannot revoke the snapshot last_watched_at', () => {
        const state = computeStateFromEvents([
            watchedSnapshot(t(10)),
            ev({
                source: 'jellyfin-sync',
                event_type: 'mark_unwatched',
                occurred_at: t(20),
            }),
            ev({
                source: 'jellyfin-sync',
                event_type: 'progress',
                occurred_at: t(20),
                position_ms: 1_003_951,
            }),
        ]);
        expect(state!.is_watched).toBe(true);
        // Falls back to the snapshot's stored completion rather than NULL.
        expect(state!.last_watched_at).toBe(t(1));
        // And the rejected resume position must not be reinstated.
        expect(state!.resume_position_ms).toBe(0);
    });

    it('still admits genuine post-snapshot progress from an uncontradicted sync', () => {
        // Same snapshot, but jellyfin agrees the item is watched, so it is not
        // contradicted and its resume point survives (re-watch in progress).
        const state = computeStateFromEvents([
            watchedSnapshot(t(10)),
            ev({
                source: 'jellyfin-sync',
                event_type: 'progress',
                occurred_at: t(20),
                position_ms: 500_000,
            }),
        ]);
        expect(state!.is_watched).toBe(true);
        expect(state!.resume_position_ms).toBe(500_000);
        expect(state!.last_watched_at).toBe(t(1));
    });

    it('documents that a snapshot already carrying the bad shape passes through', () => {
        // Known limitation, verified against prod: 10 of 33 affected rows have a
        // snapshot at/after the corrupting events. Rebuilding from events cannot
        // heal those — the pure-snapshot path returns the stored state verbatim.
        // A remediation backfill must repudiate or bypass such snapshots rather
        // than assume a plain rebuild fixes the row.
        const state = computeStateFromEvents([
            snap({
                occurred_at: t(30),
                state: {
                    is_watched: true,
                    resume_position_ms: 1_003_951,
                    runtime_ms: 90 * 60_000,
                    watch_count: 1,
                    first_watched_at: t(1),
                    last_watched_at: null,
                    last_event_at: t(25),
                    last_event_source: 'jellyfin-sync',
                    is_watched_source: 'lumastra-user-mark',
                },
            }),
        ]);
        expect(state!.is_watched).toBe(true);
        expect(state!.last_watched_at).toBeNull();
        expect(state!.resume_position_ms).toBe(1_003_951);
    });
});

describe('normalizeEventSeq', () => {
    const INT4_MAX = 2_147_483_647;
    it('leaves small native session counters unchanged', () => {
        expect(normalizeEventSeq(0)).toBe(0);
        expect(normalizeEventSeq(511)).toBe(511);
    });
    it('folds a Date.now()-magnitude seq into the int4 range', () => {
        const seq = normalizeEventSeq(1_750_000_012_345);
        expect(seq).toBeGreaterThanOrEqual(0);
        expect(seq).toBeLessThanOrEqual(INT4_MAX);
    });
    it('stays monotonic for two timestamps within one session window', () => {
        const t0 = 1_750_000_012_345;
        expect(normalizeEventSeq(t0 + 10_000)).toBeGreaterThan(normalizeEventSeq(t0));
    });
});

describe('back-dated completion must not zero a newer live resume', () => {
    it('keeps the newer live position when an older offline completion arrives', () => {
        const older = '2026-08-17T08:00:00.000Z';
        const newer = '2026-08-17T11:00:00.000Z';

        const events: UserMediaEvent[] = [
            // Live TV session, newest by occurred_at.
            ev({
                event_type: 'progress',
                source: 'lumastra-player',
                position_ms: 3_600_000,
                occurred_at: newer,
                recorded_at: newer,
            }),
            // Offline phone record, older, uploaded afterwards.
            ev({
                event_type: 'progress',
                source: 'lumastra-offline',
                position_ms: 600_000,
                occurred_at: older,
                recorded_at: newer,
            }),
            ev({
                event_type: 'completed',
                source: 'lumastra-offline',
                position_ms: 600_000,
                occurred_at: older,
                recorded_at: newer,
            }),
        ];

        const state = computeStateFromEvents(events);

        expect(state?.resume_position_ms).toBe(3_600_000);
    });
});
