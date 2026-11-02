// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ liveTV: true, autostarts: vi.fn() }));
vi.mock('$lib/server/config.js', () => ({
    features: {
        get liveTV() {
            return state.liveTV;
        },
    },
}));
vi.mock('$lib/server/services/image-descriptor/avatars.js', () => ({
    userImageSets: async () => new Map(),
}));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/database/queries/livetv-simple-mode.queries.js', () => ({
    simpleModeAutostarts: state.autostarts,
}));

import { opensLiveTvOnStart } from './simple-mode-autostart.js';

const viewer = { userId: 'u1', hasLiveTvPermission: true };

describe('opensLiveTvOnStart', () => {
    beforeEach(() => {
        state.liveTV = true;
        state.autostarts.mockReset();
    });

    it('opens Live TV when simple mode autostarts for this viewer', async () => {
        state.autostarts.mockResolvedValue(true);
        expect(await opensLiveTvOnStart(viewer)).toBe(true);
        expect(state.autostarts).toHaveBeenCalledWith({}, 'u1');
    });

    it('stays on the home page when autostart is off', async () => {
        state.autostarts.mockResolvedValue(false);
        expect(await opensLiveTvOnStart(viewer)).toBe(false);
    });

    it('never asks without Live TV, without permission or without a user', async () => {
        state.autostarts.mockResolvedValue(true);
        expect(await opensLiveTvOnStart({ userId: 'u1', hasLiveTvPermission: false })).toBe(false);
        expect(await opensLiveTvOnStart(null)).toBe(false);
        state.liveTV = false;
        expect(await opensLiveTvOnStart(viewer)).toBe(false);
        expect(state.autostarts).not.toHaveBeenCalled();
    });

    it('a database error keeps the home page', async () => {
        state.autostarts.mockRejectedValue(new Error('down'));
        expect(await opensLiveTvOnStart(viewer)).toBe(false);
    });
});
