// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A download's session id is deliberately NOT a play_sessions row — writing one
 * would log a play and close the user's other music sessions, so pulling an
 * album for offline use would log twelve plays and tear down whatever is
 * actually playing.
 *
 * The cost of that choice is that the id cannot go anywhere a real one does:
 * `active_transcode_jobs.play_session_id` is `uuid NOT NULL` with an FK to
 * `play_sessions`, so persisting it raised 22P02 on EVERY download, was
 * swallowed by a catch, and logged a warning instead of recording a job. These
 * tests pin the predicate that keeps the two kinds of id apart.
 */
import { describe, it, expect } from 'vitest';
import { PLAYER_SESSION_PREFIX, SYNTHETIC_SESSION_PREFIX, isSyntheticSessionId } from './types.js';

const USER_ID = 'a1ce0000-0000-4000-a000-000000000000';
const TRACK_ID = 'b2df0000-0000-4000-a000-000000000000';

describe('isSyntheticSessionId', () => {
    it('recognises the id the download path actually builds', () => {
        // Kept in the same shape as route-handler.ts so a change to one
        // without the other fails here rather than in production.
        const id = `${SYNTHETIC_SESSION_PREFIX}${USER_ID}:${TRACK_ID}`;
        expect(isSyntheticSessionId(id)).toBe(true);
    });

    it('does not claim a real play_sessions UUID', () => {
        expect(isSyntheticSessionId(USER_ID)).toBe(false);
    });

    it('is never satisfied by a bare UUID, which is what the column accepts', () => {
        // The prefix has to be something no uuid can start with, or the guard
        // would divert real sessions away from being recorded.
        expect(SYNTHETIC_SESSION_PREFIX).toMatch(/[^0-9a-f-]/);
    });

    it('recognises the id the player-reported transcode path builds', () => {
        // route-handler.ts: our own player's fetch while it reports the listen
        // through /play-sessions/{id}. Persisting it would fail the same way.
        const id = `${PLAYER_SESSION_PREFIX}${USER_ID}:${TRACK_ID}`;
        expect(isSyntheticSessionId(id)).toBe(true);
        expect(PLAYER_SESSION_PREFIX).toMatch(/[^0-9a-f-]/);
    });
});
