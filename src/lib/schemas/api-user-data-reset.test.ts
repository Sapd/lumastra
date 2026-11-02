// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { userDataResetBodySchema, DESTRUCTIVE_ACTIONS } from './api-user-data-reset.js';

describe('userDataResetBodySchema', () => {
    it('accepts a valid action', () => {
        expect(userDataResetBodySchema.parse({ action: 'music-recs' }).action).toBe('music-recs');
    });
    it('rejects an unknown action', () => {
        expect(userDataResetBodySchema.safeParse({ action: 'nope' }).success).toBe(false);
    });
    it('marks the three history/feedback wipes as destructive', () => {
        expect([...DESTRUCTIVE_ACTIONS].sort()).toEqual(
            ['music-feedback', 'music-history', 'vod-history'].sort(),
        );
    });
});
