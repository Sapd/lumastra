// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import type { SessionRow } from '$lib/server/database/queries/play-sessions.queries.js';
import { candidateCrossedCompletion } from './play-sessions.service.js';

const HOUR_MS = 60 * 60 * 1000; // tiered episode threshold = 0.90
const TWO_HOUR_MS = 2 * HOUR_MS; // 90-150min tier = 0.95

function candidate(over: Partial<SessionRow>): SessionRow {
    return {
        device_id: 'device-native-1',
        media_type: 'episode',
        position_ms: 0,
        runtime_ms: HOUR_MS,
        ...over,
    } as unknown as SessionRow;
}

describe('candidateCrossedCompletion', () => {
    it('finalizes a compat episode at 0.91 (0.90 parity)', () => {
        expect(
            candidateCrossedCompletion(
                candidate({
                    device_id: 'jellyfin-compat-u',
                    position_ms: Math.floor(HOUR_MS * 0.91),
                }),
            ),
        ).toBe(true);
    });

    it('does NOT finalize a native episode at 0.91 of a 2h runtime (keeps 0.95 tier)', () => {
        expect(
            candidateCrossedCompletion(
                candidate({
                    device_id: 'device-native-1',
                    runtime_ms: TWO_HOUR_MS,
                    position_ms: Math.floor(TWO_HOUR_MS * 0.91),
                }),
            ),
        ).toBe(false);
    });

    it('does NOT finalize a compat MOVIE at 0.91 of a 2h runtime (episodes-only scoping)', () => {
        expect(
            candidateCrossedCompletion(
                candidate({
                    device_id: 'jellyfin-compat-u',
                    media_type: 'movie',
                    runtime_ms: TWO_HOUR_MS,
                    position_ms: Math.floor(TWO_HOUR_MS * 0.91),
                }),
            ),
        ).toBe(false);
    });

    it('returns false when runtime is unknown (0)', () => {
        expect(
            candidateCrossedCompletion(
                candidate({ device_id: 'jellyfin-compat-u', runtime_ms: 0, position_ms: 1000 }),
            ),
        ).toBe(false);
    });
});
