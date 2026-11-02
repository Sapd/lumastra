// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, expect, it, vi } from 'vitest';
import { config } from '$lib/server/config.js';
import { UserSettingsResponseSchema } from '$lib/schemas/api-user-responses.js';
import type { RequestEvent } from '@sveltejs/kit';

const mocks = vi.hoisted(() => ({ playback: vi.fn() }));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => vi.fn(async () => []) }));
vi.mock('$lib/server/database/queries/index.js', () => ({
    getWidgetOrder: { one: vi.fn(async () => null) },
    getPlaybackPreferences: { one: mocks.playback },
}));
const { def } = await import('./settings');
const event = {
    locals: { user: { userId: 'user-1', username: 'alice' } },
} as unknown as RequestEvent;

beforeEach(() => vi.clearAllMocks());

it('composite settings default beat pulse off for new users and missing fields', async () => {
    for (const row of [null, {}]) {
        mocks.playback.mockResolvedValue(row);
        const response = await def.handlers.GET!(event, {} as never);
        expect(await response.json()).toMatchObject({
            playbackPreferences: { musicAlwaysShowBeatPulse: false },
        });
    }
});
it('composite settings return the saved beat pulse preference', async () => {
    mocks.playback.mockResolvedValue({ music_always_show_beat_pulse: true });
    const response = await def.handlers.GET!(event, {} as never);
    expect(await response.json()).toMatchObject({
        playbackPreferences: { musicAlwaysShowBeatPulse: true },
    });
});

it('composite settings fall back to hiding streams when privacy data is missing', async () => {
    const response = await def.handlers.GET!(event, {} as never);
    expect(await response.json()).toMatchObject({
        streamPrivacy: { hideFromOthers: true },
    });
});

it.each([null, { next_episode_countdown_seconds: 25 }])(
    'composite settings satisfy the playback schema with the configured countdown default',
    async (row) => {
        vi.spyOn(config, 'NEXT_EPISODE_COUNTDOWN_SECONDS', 'get').mockReturnValue(17);
        try {
            mocks.playback.mockResolvedValue(row);
            const response = await def.handlers.GET!(event, {} as never);
            const body = await response.json();
            expect(
                UserSettingsResponseSchema.parse(body).playbackPreferences
                    .nextEpisodeCountdownSecondsDefault,
            ).toBe(17);
        } finally {
            vi.restoreAllMocks();
        }
    },
);

it.each([
    [null, true],
    [{}, true],
    [{ show_episode_languages: false }, false],
    [{ show_episode_languages: true }, true],
] as const)(
    'composite settings preserve episode-language visibility (%j)',
    async (row, expected) => {
        mocks.playback.mockResolvedValue(row);
        const response = await def.handlers.GET!(event, {} as never);
        const body = UserSettingsResponseSchema.parse(await response.json());
        expect(body.playbackPreferences.showEpisodeLanguages).toBe(expected);
    },
);
