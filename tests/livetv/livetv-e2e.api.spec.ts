// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { test, expect, missingFfmpeg, ffmpegSkipReason } from './fixtures';
import {
    api,
    fixtureState,
    json,
    expectStatus,
    start,
    leave,
    keepalive,
    state,
    sample,
    decode,
    providerStatus,
    waitForSlots,
} from './harness';
import type { Feed, Station } from './harness';
import { viewerTimeoutSeconds, graceSeconds } from './env';

test.describe('real Live TV @livetv', (): void => {
    test.skip(missingFfmpeg, ffmpegSkipReason);

    test('station identity, grouped shown feed, favourites, simple mode and guide', async ({
        actors,
    }): Promise<void> => {
        const client = actors.alice.request;
        const { items } = await json<{ items: Station[] }>(await client.get(`${api}/stations`));
        expect(items).toHaveLength(4);
        expect(new Set(items.map((station) => station.id)).size).toBe(4);
        const grouped = items.find((station) => station.name.startsWith('Kids Four'));
        expect(grouped).toBeDefined();
        if (!grouped) throw new Error('Kids Four missing');
        const group = await json<{ stationId: string; feeds: Feed[] }>(
            await client.get(`${api}/stations/${grouped.id}/feeds`),
        );
        expect(group.stationId).toBe(grouped.id);
        expect(group.feeds).toHaveLength(2);
        expect(group.feeds.find((feed) => feed.isDefault)?.id).toBe(grouped.feedId);
        expect(grouped.id).not.toBe(grouped.feedId);
        await json(
            await client.put(`${api}/favorites`, {
                data: { stationId: grouped.id, favorite: true },
            }),
        );
        expect(await json(await client.get(`${api}/favorites`))).toEqual({
            stationIds: [grouped.id],
        });
        const stationIds = [grouped.id, items.find((station) => station.id !== grouped.id)!.id];
        await json(
            await client.patch(`${api}/simple-mode`, {
                data: {
                    enabled: true,
                    layout: 'tiles',
                    stationIds,
                    startStationId: grouped.id,
                },
            }),
        );
        expect(await json(await client.get(`${api}/simple-mode`))).toMatchObject({
            enabled: true,
            stationIds,
            startStationId: grouped.id,
        });
        expect(await json(await client.get(`${api}/favorites`))).toEqual({ stationIds });
        const window = new URLSearchParams({
            from: new Date(Date.now() - 3600_000).toISOString(),
            to: new Date(Date.now() + 3600_000).toISOString(),
            stationIds: items.map((station) => station.id).join(','),
        });
        const guide = await json<{
            stations: { stationId: string; airings: { title: string }[] }[];
        }>(await client.get(`${api}/guide?${window}`));
        expect(guide.stations.map((station) => station.stationId).sort()).toEqual(
            items.map((station) => station.id).sort(),
        );
        for (const station of guide.stations) {
            expect(station.airings.length).toBeGreaterThan(0);
            expect(station.airings.every((airing) => airing.title.includes('Signal Garden'))).toBe(
                true,
            );
        }
        // This user also drives the UI spec; leave its normal grid enabled.
        await json(
            await client.patch(`${api}/simple-mode`, {
                data: { enabled: false, stationIds: [], clearStartStation: true },
            }),
        );
    });

    test('start, decode two app-served segments, heartbeat, state and leave', async ({
        actors,
    }): Promise<void> => {
        const client = actors.alice.request;
        const session = await start(client, fixtureState().stations[0]);
        await decode(await sample(client, session.delivery.url));
        await waitForSlots(1);
        const denied = await fetch(`${fixtureState().provider.baseUrl}/stream/sports-two.ts`, {
            signal: AbortSignal.timeout(5000),
        });
        try {
            expect(denied.status, 'provider itself enforces its connection cap').toBe(429);
        } finally {
            await denied.body?.cancel();
        }
        await expectStatus(await keepalive(client, session), 204);
        expect(await state(client, session)).toMatchObject({ state: 'active' });
        await leave(client, session);
        await leave(client, session); // Idempotent.
        await waitForSlots(0);
        expect(await state(client, session)).toMatchObject({ state: 'ended', endReason: 'left' });
    });

    test('one provider slot, priority eviction, guarded rejoin and consume-once notification', async ({
        actors,
    }): Promise<void> => {
        const alice = actors.alice.request;
        const admin = actors.admin.request;
        const [a, b] = fixtureState().stations;
        const first = await start(alice, a);
        await decode(await sample(alice, first.delivery.url));
        const refused = await actors.bob.request.post(`${api}/playback-sessions`, {
            data: { stationId: b.id },
        });
        expect(await json(refused, 503)).toMatchObject({ reason: 'stream_limit' });
        const takeover = await start(admin, b);
        await decode(await sample(admin, takeover.delivery.url));
        // Check BEFORE heartbeat: heartbeat consumes the channel-specific kicked flag.
        expect(
            await json(
                await alice.post(`${api}/playback-sessions`, { data: { stationId: a.id } }),
                410,
            ),
        ).toMatchObject({ reason: 'evicted' });
        const notification = await json<{ reason: string; details?: string }>(
            await keepalive(alice, first),
            410,
        );
        expect(notification).toMatchObject({
            reason: 'evicted',
            details: 'higher_priority_viewer',
        });
        const repeated = await json<{ reason: string; details?: string }>(
            await keepalive(alice, first),
            410,
        );
        expect(repeated.reason).toBe('evicted');
        expect(repeated.details).toBeUndefined(); // Notification consumed, ended state persists.
        await leave(admin, takeover);
        await waitForSlots(0);
        const rejoined = await start(alice, a); // Guard consumed, may explicitly join again.
        await decode(await sample(alice, rejoined.delivery.url));
        await leave(alice, rejoined);
    });

    test('preview admission never supersedes real playback or changes favourites', async ({
        actors,
    }): Promise<void> => {
        const client = actors.alice.request;
        const station = fixtureState().stations.find((item) => item.name.startsWith('Kids Four'))!;
        const { feeds } = await json<{ feeds: Feed[] }>(
            await client.get(`${api}/stations/${station.id}/feeds`),
        );
        const other = feeds.find((feed) => feed.id !== station.feedId)!;
        const playing = await start(client, station);
        await decode(await sample(client, playing.delivery.url));
        const before = await json(await client.get(`${api}/favorites`));
        // Different feed needs another provider slot. A preview must refuse, never evict.
        expect(
            await json(
                await client.post(`${api}/playback-sessions`, {
                    data: { stationId: station.id, feedId: other.id, purpose: 'preview' },
                }),
                503,
            ),
        ).toMatchObject({ reason: 'stream_limit' });
        // The same feed can share the ingest slot and exercise an accepted preview.
        const preview = await start(client, station, { purpose: 'preview' });
        expect(preview.playbackSessionId).not.toBe(playing.playbackSessionId);
        await decode(await sample(client, preview.delivery.url));
        expect(await state(client, playing)).toMatchObject({ state: 'active' });
        await expectStatus(await keepalive(client, playing), 204);
        await leave(client, preview);
        expect(await state(client, playing)).toMatchObject({ state: 'active' });
        await expectStatus(await keepalive(client, playing), 204);
        expect(await json(await client.get(`${api}/favorites`))).toEqual(before);
        // No public Live TV watch-history endpoint exists; see runbook.
        await leave(client, playing);
    });

    test('VLC-style segment traffic keeps a viewer alive without any heartbeat', async ({
        actors,
    }): Promise<void> => {
        const client = actors.alice.request;
        const session = await start(client, fixtureState().stations[0]);
        const first = await sample(client, session.delivery.url);
        await decode(first);
        const deadline = Date.now() + (viewerTimeoutSeconds * 2 + 2) * 1000;
        const seen = new Set(first.segmentUrls);
        // Only playlists and segments during the liveness window; no session GET,
        // POST keepalive or new join. Polling the master would itself rejoin, so
        // subsequent reads start at the MEDIA playlist returned by sample().
        await expect
            .poll(
                async (): Promise<boolean> => {
                    const media = await sample(client, first.playlistUrl);
                    media.segmentUrls.forEach((url) => seen.add(url));
                    await decode(media);
                    return Date.now() >= deadline;
                },
                { timeout: (viewerTimeoutSeconds * 2 + 35) * 1000, intervals: [1000] },
            )
            .toBe(true);
        expect(
            seen.size,
            'fresh segment sequence numbers, not repeated cached bytes',
        ).toBeGreaterThan(4);
        expect(await state(client, session)).toMatchObject({ state: 'active' });
        // Stop ALL media reads. Observe the provider only: GET state is read-only,
        // and a keepalive here would defeat the expiry assertion.
        await waitForSlots(0, (viewerTimeoutSeconds + graceSeconds + 5) * 1000);
        // An expired proxy viewer cannot be revived by its stale heartbeat.
        expect(await json(await keepalive(client, session), 404)).toMatchObject({
            reason: 'session_expired',
        });
        expect(await state(client, session)).toMatchObject({
            state: 'ended',
            endReason: 'expired',
        });
    });

    test('explicit SD feed choice opens the SD provider URL', async ({ actors }): Promise<void> => {
        const client = actors.alice.request;
        const station = fixtureState().stations.find((item) => item.name.startsWith('Kids Four'))!;
        const { feeds } = await json<{ feeds: Feed[] }>(
            await client.get(`${api}/stations/${station.id}/feeds`),
        );
        const sd = feeds.find((feed) => feed.qualityTier === 'sd');
        expect(sd).toBeDefined();
        const before = (await providerStatus()).events.at(-1)?.sequence ?? 0;
        const session = await start(client, station, { feedId: sd!.id });
        expect(session.delivery.feedId).toBe(sd!.id);
        await decode(await sample(client, session.delivery.url));
        const status = await providerStatus();
        expect(status.active).toEqual([expect.objectContaining({ id: 'kids-four-sd' })]);
        expect(
            status.events.some(
                (event) =>
                    event.sequence > before &&
                    event.event === 'opened' &&
                    event.id === 'kids-four-sd',
            ),
        ).toBe(true);
        await leave(client, session);
    });
});
