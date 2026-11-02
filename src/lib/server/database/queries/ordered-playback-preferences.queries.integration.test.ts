// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { getTestDatabaseUrl } from '../../../../../tests/integration/setup/test-database';
import { ensureTestUser, generateTestUserId } from '../../../../../tests/integration/fixtures';
import type { UserId } from '$lib/shared/user-id';
import type { PlaybackPreferenceWriteOrder } from '$lib/schemas/user';
import { withTx } from '../with-tx';
import { upsertOrderedPlaybackPreferences } from './ordered-playback-preferences.queries';
import { getPlaybackPreferences, upsertPlaybackPreferences } from './user-preferences.queries';

function order(
    fields: string[],
    clock: number,
    generation = 1,
    deviceId = 'browser-a',
    epochId = `epoch-${generation}`,
    operationId = `edit-${clock}`,
): PlaybackPreferenceWriteOrder {
    return {
        deviceId,
        epochGeneration: generation,
        epochId,
        fields: Object.fromEntries(fields.map((field) => [field, { clock, operationId }])),
    };
}

describe('atomic browser preference write order (real PostgreSQL)', () => {
    // Independent physical connections: a single pool can serialize a broken
    // guard accidentally, hiding the database compare/write race.
    const first = postgres(getTestDatabaseUrl(), { max: 1 });
    const second = postgres(getTestDatabaseUrl(), { max: 1 });
    const users: UserId[] = [];
    async function user(): Promise<UserId> {
        const id = generateTestUserId();
        await ensureTestUser(first, id);
        users.push(id);
        return id;
    }
    beforeAll(async () => {
        await first`SELECT 1`;
        await second`SELECT 1`;
    });
    afterAll(async () => {
        for (const id of users) await first`DELETE FROM users WHERE id = ${id}`;
        await Promise.all([first.end(), second.end()]);
    });

    it('keeps a newer episode-language Off edit when an older On request arrives later', async () => {
        const id = await user();
        await upsertOrderedPlaybackPreferences(
            first,
            id,
            { showEpisodeLanguages: false },
            order(['showEpisodeLanguages'], 20),
        );
        await upsertOrderedPlaybackPreferences(
            second,
            id,
            { showEpisodeLanguages: true },
            order(['showEpisodeLanguages'], 10),
        );
        expect(
            (await getPlaybackPreferences.one(first, { userId: id }))?.show_episode_languages,
        ).toBe(false);
    });

    it('ignores a closed tab keepalive arriving after a newer successful write', async () => {
        const id = await user();
        let releaseOld!: () => void;
        const delayedArrival = new Promise<void>((resolve) => {
            releaseOld = resolve;
        });
        const oldRequest = delayedArrival.then(() =>
            upsertOrderedPlaybackPreferences(
                first,
                id,
                { subtitleLanguage: 'de' },
                order(['subtitleLanguage'], 10),
            ),
        );
        const newest = await upsertOrderedPlaybackPreferences(
            second,
            id,
            { subtitleLanguage: 'ja' },
            order(['subtitleLanguage'], 20),
        );
        expect(newest?.subtitle_language).toBe('ja'); // Newer HTTP request can now ACK/delete its journal.
        releaseOld();
        expect((await oldRequest)?.subtitle_language).toBe('ja');
        expect((await getPlaybackPreferences.one(first, { userId: id }))?.subtitle_language).toBe(
            'ja',
        );
        const ledger =
            await first`SELECT edit_clock FROM user_playback_preference_orders WHERE user_id = ${id} AND field = 'subtitleLanguage'`;
        expect(Number(ledger[0].edit_clock)).toBe(20);
    });

    it('compares each supplied field independently, preserving omissions and explicit null clears', async () => {
        const id = await user();
        await upsertOrderedPlaybackPreferences(
            first,
            id,
            { subtitleLanguage: 'ja', audioLanguage: 'fr' },
            order(['subtitleLanguage', 'audioLanguage'], 30),
        );
        await upsertOrderedPlaybackPreferences(
            second,
            id,
            { subtitleLanguage: 'de', audioLanguage: null, subtitlesEnabled: false },
            {
                ...order(['subtitleLanguage', 'audioLanguage', 'subtitlesEnabled'], 20),
                fields: {
                    subtitleLanguage: { clock: 20, operationId: 'old' },
                    audioLanguage: { clock: 40, operationId: 'clear' },
                    subtitlesEnabled: { clock: 20, operationId: 'off' },
                },
            },
        );
        expect(await getPlaybackPreferences.one(first, { userId: id })).toMatchObject({
            subtitle_language: 'ja',
            audio_language: null,
            subtitles_enabled: false,
        });
        await upsertOrderedPlaybackPreferences(
            second,
            id,
            { subtitleLanguage: 'ko' },
            order(['subtitleLanguage'], 30, 1, 'browser-a', 'epoch-1', 'zz-newer-tie'),
        );
        expect((await getPlaybackPreferences.one(first, { userId: id }))?.subtitle_language).toBe(
            'ko',
        );
    });

    it('hint-derived scalar orders cannot overwrite newer explicit scalar edits', async () => {
        const id = await user();
        await upsertOrderedPlaybackPreferences(
            first,
            id,
            { subtitleLanguage: 'fr', forcedSubtitlesEnabled: false },
            order(['subtitleLanguage', 'forcedSubtitlesEnabled'], 30),
        );
        const hint = { language: 'de', isForced: true, codec: 'srt' };
        // The handler projects the hint into these scalars with the same token.
        await upsertOrderedPlaybackPreferences(
            second,
            id,
            {
                subtitleTrackHint: JSON.stringify(hint),
                subtitleLanguage: hint.language,
                forcedSubtitlesEnabled: hint.isForced,
            },
            order(['subtitleTrackHint', 'subtitleLanguage', 'forcedSubtitlesEnabled'], 20),
        );
        const saved = await getPlaybackPreferences.one(first, { userId: id });
        expect(saved).toMatchObject({ subtitle_language: 'fr', forced_subtitles_enabled: false });
        // The existing route/query boundary serializes JSON preference values.
        const savedHint = saved?.subtitle_track_hint;
        expect(typeof savedHint === 'string' ? JSON.parse(savedHint) : savedHint).toEqual(hint);
    });

    it('retires old account epochs for the same browser/user, including previously unseen fields', async () => {
        const id = await user();
        await upsertOrderedPlaybackPreferences(
            first,
            id,
            { subtitleLanguage: 'de' },
            order(['subtitleLanguage'], 100),
        );
        await upsertOrderedPlaybackPreferences(
            second,
            id,
            { subtitleLanguage: 'fr' },
            order(['subtitleLanguage'], 1, 2),
        );
        const stale = await upsertOrderedPlaybackPreferences(
            first,
            id,
            { subtitleLanguage: 'ja', audioLanguage: 'ko' },
            order(['subtitleLanguage', 'audioLanguage'], 1000),
        );
        expect(stale).toMatchObject({ subtitle_language: 'fr', audio_language: null });
        await upsertOrderedPlaybackPreferences(
            first,
            id,
            { subtitleLanguage: 'it' },
            order(['subtitleLanguage'], 1000, 2, 'browser-a', 'conflicting-epoch'),
        );
        expect((await getPlaybackPreferences.one(first, { userId: id }))?.subtitle_language).toBe(
            'fr',
        );
        expect(
            await first`SELECT field FROM user_playback_preference_orders WHERE user_id = ${id}`,
        ).toHaveLength(1);
    });

    it('isolates authenticated users and devices, while retaining legacy last-write-wins updates', async () => {
        const a = await user();
        const b = await user();
        await upsertOrderedPlaybackPreferences(
            first,
            a,
            { audioLanguage: 'de' },
            order(['audioLanguage'], 100, 10),
        );
        await upsertOrderedPlaybackPreferences(
            second,
            b,
            { audioLanguage: 'fr' },
            order(['audioLanguage'], 1),
        );
        expect((await getPlaybackPreferences.one(first, { userId: a }))?.audio_language).toBe('de');
        expect((await getPlaybackPreferences.one(first, { userId: b }))?.audio_language).toBe('fr');
        await upsertOrderedPlaybackPreferences(
            second,
            a,
            { audioLanguage: 'ja' },
            order(['audioLanguage'], 1, 1, 'independent-browser'),
        );
        expect((await getPlaybackPreferences.one(first, { userId: a }))?.audio_language).toBe('ja');
        await upsertPlaybackPreferences(first, a, { audioLanguage: 'it' });
        expect((await getPlaybackPreferences.one(first, { userId: a }))?.audio_language).toBe('it');
    });

    it('rolls back ledger advancement when the preference update fails, including nested transactions', async () => {
        const id = await user();
        await upsertOrderedPlaybackPreferences(
            first,
            id,
            { audioLanguage: 'de' },
            order(['audioLanguage'], 10),
        );
        await expect(
            withTx(first, async (tx) => {
                await upsertOrderedPlaybackPreferences(
                    tx,
                    id,
                    { audioLanguage: 'x'.repeat(21) },
                    order(['audioLanguage'], 30),
                );
            }),
        ).rejects.toMatchObject({ code: '22001' });
        await upsertOrderedPlaybackPreferences(
            second,
            id,
            { audioLanguage: 'fr' },
            order(['audioLanguage'], 20),
        );
        expect((await getPlaybackPreferences.one(first, { userId: id }))?.audio_language).toBe(
            'fr',
        );
    });

    it('blocks simultaneous compare-and-write transactions and converges to the latest field order', async () => {
        const id = await user();
        let locked!: () => void;
        let release!: () => void;
        const acquired = new Promise<void>((resolve) => {
            locked = resolve;
        });
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const held = withTx(first, async (tx) => {
            await tx`SELECT pg_advisory_xact_lock(164270, hashtext(${id}))`;
            locked();
            await gate;
            return upsertOrderedPlaybackPreferences(
                tx,
                id,
                { audioLanguage: 'de' },
                order(['audioLanguage'], 10),
            );
        });
        await acquired;
        let completed = false;
        const waiting = upsertOrderedPlaybackPreferences(
            second,
            id,
            { audioLanguage: 'fr' },
            order(['audioLanguage'], 20),
        ).then((row) => {
            completed = true;
            return row;
        });
        // Wait until PostgreSQL itself reports the second connection blocked,
        // rather than treating a scheduling delay as proof of exclusion.
        const observer = postgres(getTestDatabaseUrl(), { max: 1 });
        try {
            await expect
                .poll(async () => {
                    const rows =
                        await observer`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%pg_advisory_xact_lock(164270%'`;
                    return rows[0].count;
                })
                .toBeGreaterThan(0);
            expect(completed).toBe(false);
        } finally {
            release();
            await observer.end();
        }
        await held;
        await waiting;
        expect((await getPlaybackPreferences.one(first, { userId: id }))?.audio_language).toBe(
            'fr',
        );
    });

    it('cascades ordering metadata on account deletion', async () => {
        const id = await user();
        await upsertOrderedPlaybackPreferences(
            first,
            id,
            { audioLanguage: 'de' },
            order(['audioLanguage'], 1),
        );
        await first`DELETE FROM users WHERE id = ${id}`;
        expect(
            await first`SELECT 1 FROM user_playback_preference_devices WHERE user_id = ${id}`,
        ).toHaveLength(0);
        expect(
            await first`SELECT 1 FROM user_playback_preference_orders WHERE user_id = ${id}`,
        ).toHaveLength(0);
    });
});
