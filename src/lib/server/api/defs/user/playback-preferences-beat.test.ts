// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mocks = vi.hoisted(() => ({ get: vi.fn(), upsert: vi.fn(), ordered: vi.fn() }));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/config.js', () => ({
    config: {
        NEXT_EPISODE_COUNTDOWN_SECONDS: 10,
        TMDB_LANGUAGE: 'en-US',
        METADATA_ADDITIONAL_LANGUAGES: [],
    },
}));
vi.mock('$lib/server/database/queries/user-preferences.queries.js', async (original) => ({
    ...(await original<typeof import('$lib/server/database/queries/user-preferences.queries')>()),
    getPlaybackPreferences: { one: mocks.get },
    upsertPlaybackPreferences: mocks.upsert,
}));
vi.mock('$lib/server/database/queries/ordered-playback-preferences.queries', () => ({
    upsertOrderedPlaybackPreferences: mocks.ordered,
}));
const { def } = await import('./playback-preferences');
const event = {
    locals: { user: { userId: 'user-1', username: 'alice' } },
} as unknown as RequestEvent;

beforeEach(() => vi.clearAllMocks());

it('GET defaults episode languages on and PATCH round trips both visibility values', async () => {
    mocks.get.mockResolvedValue(null);
    expect(await (await def.handlers.GET!(event, {} as never)).json()).toMatchObject({
        showEpisodeLanguages: true,
    });
    for (const enabled of [false, true]) {
        mocks.get.mockResolvedValue({ show_episode_languages: enabled });
        expect(await (await def.handlers.GET!(event, {} as never)).json()).toMatchObject({
            showEpisodeLanguages: enabled,
        });
        mocks.upsert.mockResolvedValue({ show_episode_languages: enabled });
        const response = await def.handlers.PATCH!(event, {
            input: { body: { showEpisodeLanguages: enabled } },
        } as never);
        expect(response.status).toBe(200);
        expect(mocks.upsert).toHaveBeenLastCalledWith(expect.anything(), 'user-1', {
            showEpisodeLanguages: enabled,
        });
        expect(await response.json()).toMatchObject({ showEpisodeLanguages: enabled });
    }
});

it('GET defaults off for new users and missing database fields', async () => {
    for (const row of [null, {}]) {
        mocks.get.mockResolvedValue(row);
        const response = await def.handlers.GET!(event, {} as never);
        expect(await response.json()).toMatchObject({ musicAlwaysShowBeatPulse: false });
    }
});
it('GET returns the saved enabled preference', async () => {
    mocks.get.mockResolvedValue({ music_always_show_beat_pulse: true });
    const response = await def.handlers.GET!(event, {} as never);
    expect(await response.json()).toMatchObject({ musicAlwaysShowBeatPulse: true });
});
it('PATCH preserves both true and false through the database update and response', async () => {
    for (const enabled of [true, false]) {
        mocks.upsert.mockResolvedValue({ music_always_show_beat_pulse: enabled });
        const response = await def.handlers.PATCH!(event, {
            input: { body: { musicAlwaysShowBeatPulse: enabled } },
        } as never);
        expect(response.status).toBe(200);
        expect(mocks.upsert).toHaveBeenLastCalledWith(expect.anything(), 'user-1', {
            musicAlwaysShowBeatPulse: enabled,
        });
        expect(await response.json()).toMatchObject({ musicAlwaysShowBeatPulse: enabled });
    }
});
it('PATCH rejects a non-boolean value without writing it', async () => {
    const response = await def.handlers.PATCH!(event, {
        input: { body: { musicAlwaysShowBeatPulse: 'true' } },
    } as never);
    expect(response.status).toBe(422);
    expect(mocks.upsert).not.toHaveBeenCalled();
});

it('PATCH writes only supplied fields, preserving omitted preference values', async () => {
    mocks.upsert.mockResolvedValue({
        audio_language: 'de',
        subtitles_enabled: false,
        music_always_show_beat_pulse: true,
    });
    const response = await def.handlers.PATCH!(event, {
        input: { body: { subtitlesEnabled: false } },
    } as never);
    expect(mocks.upsert).toHaveBeenLastCalledWith(expect.anything(), 'user-1', {
        subtitlesEnabled: false,
    });
    expect(await response.json()).toMatchObject({
        audioLanguage: 'de',
        subtitlesEnabled: false,
        musicAlwaysShowBeatPulse: true,
    });
});

it('PATCH binds ordered writes to the authenticated user and orders derived hint scalars', async () => {
    mocks.ordered.mockResolvedValue({ subtitle_language: 'de', forced_subtitles_enabled: true });
    const token = { clock: 20, operationId: 'hint-edit' };
    const explicit = { clock: 30, operationId: 'explicit-edit' };
    for (const scalar of [false, true]) {
        const body = {
            subtitleTrackHint: { language: 'de', isForced: true, codec: 'srt' },
            ...(scalar ? { subtitleLanguage: 'fr' } : {}),
            writeOrder: {
                deviceId: 'browser-a',
                epochGeneration: 1,
                epochId: 'epoch-a',
                fields: {
                    subtitleTrackHint: token,
                    ...(scalar ? { subtitleLanguage: explicit } : {}),
                },
            },
        };
        const response = await def.handlers.PATCH!(event, { input: { body } } as never);
        expect(response.status).toBe(200);
        expect(mocks.ordered).toHaveBeenLastCalledWith(
            expect.anything(),
            'user-1',
            expect.objectContaining({
                subtitleLanguage: scalar ? 'fr' : 'de',
                forcedSubtitlesEnabled: true,
            }),
            expect.objectContaining({
                fields: {
                    subtitleTrackHint: token,
                    subtitleLanguage: scalar ? explicit : token,
                    forcedSubtitlesEnabled: token,
                },
            }),
        );
    }
    expect(mocks.upsert).not.toHaveBeenCalled();
});

it('PATCH rejects incomplete or forged ordering metadata before database access', async () => {
    const valid = {
        deviceId: 'browser-a',
        epochGeneration: 1,
        epochId: 'epoch-a',
        fields: { audioLanguage: { clock: 20, operationId: 'edit-a' } },
    };
    for (const writeOrder of [
        { ...valid, fields: {} },
        { ...valid, userId: 'someone-else' },
        { ...valid, epochGeneration: Number.MAX_SAFE_INTEGER + 1 },
        { ...valid, fields: { audioLanguage: { clock: -1, operationId: 'bad' } } },
        { ...valid, fields: JSON.parse('{"constructor":{"clock":1,"operationId":"bad"}}') },
    ]) {
        const response = await def.handlers.PATCH!(event, {
            input: { body: { audioLanguage: 'de', writeOrder } },
        } as never);
        expect(response.status).toBe(422);
    }
    expect(mocks.ordered).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
});
