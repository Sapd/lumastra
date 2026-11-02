// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('reporting cannot change sharing policy', () => {
    it.each([
        './play-session-lifecycle.service.ts',
        './music-interaction-manager.service.ts',
        './music/play-end-batch.service.ts',
        './audiobook-session.service.ts',
        './music-session-live-info.ts',
        '../api/defs/play-sessions/list.ts',
        '../api/defs/user/music/tracks/[id]/feedback.ts',
        '../database/queries/music-tracking.queries.ts',
        '../database/queries/music-interactions.queries.ts',
        '../api/defs/play-sessions/[id].ts',
        '../api/defs/play-sessions/[id]/beacon.ts',
        '../api/defs/play-sessions/replay.ts',
    ])('%s has no sharing-policy dependency or writes', (path) => {
        const source = readFileSync(new URL(path, import.meta.url), 'utf8');
        expect(source).not.toMatch(
            /social-visibility\.builder|share_(?:viewing|listening)_history|share_(?:listening|audiobook)_activity|share_opt_out|share(?:Viewing|Listening)History/,
        );
    });
});
