// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { mapPlayMethod, isSessionFresh, serializeJellyfinSession } from './session';
import type { ActiveSessionWithMedia } from '$lib/server/database/queries/play-sessions.queries';

function makeSession(overrides: Partial<Record<string, unknown>> = {}): ActiveSessionWithMedia {
    return {
        id: '550e8400-e29b-41d4-a716-446655440000',
        media_id: 'b3d7e123-0000-0000-0000-000000000001',
        // user_id is the stable users.id UUID (mig 16.46.0); display uses the
        // resolved owner_username instead.
        user_id: '11111111-1111-4111-8111-111111111111',
        owner_username: 'denis',
        owner_display_name: null,
        device_id: 'device-abc',
        client_name: 'Lumastra Web',
        device_name: 'My Browser',
        client_version: '2.0.0',
        status: 'ACTIVE',
        position_ms: 30000,
        play_method: 'direct',
        source: 'lumastra',
        last_heartbeat_at: new Date(),
        last_seen_at: new Date(),
        ...overrides,
    } as unknown as ActiveSessionWithMedia;
}

describe('mapPlayMethod', () => {
    it('maps direct to DirectPlay', () => {
        expect(mapPlayMethod('direct')).toBe('DirectPlay');
    });

    it('maps remux to DirectStream', () => {
        expect(mapPlayMethod('remux')).toBe('DirectStream');
    });

    it('maps audio_transcode to Transcode', () => {
        expect(mapPlayMethod('audio_transcode')).toBe('Transcode');
    });

    it('maps full_transcode to Transcode', () => {
        expect(mapPlayMethod('full_transcode')).toBe('Transcode');
    });

    it('maps unknown values to DirectPlay', () => {
        expect(mapPlayMethod('unknown')).toBe('DirectPlay');
    });
});

describe('isSessionFresh', () => {
    it('returns true for a Lumastra ACTIVE session with recent heartbeat', () => {
        const session = makeSession({
            last_heartbeat_at: new Date(Date.now() - 10_000),
        });
        expect(isSessionFresh(session)).toBe(true);
    });

    it('returns false for a Lumastra ACTIVE session with stale heartbeat (>30s)', () => {
        const session = makeSession({
            last_heartbeat_at: new Date(Date.now() - 35_000),
        });
        expect(isSessionFresh(session)).toBe(false);
    });

    it('returns true for a Lumastra PAUSED session heartbeat within 5 minutes', () => {
        const session = makeSession({
            status: 'PAUSED',
            last_heartbeat_at: new Date(Date.now() - 4 * 60_000),
        });
        expect(isSessionFresh(session)).toBe(true);
    });

    it('returns false for a Lumastra PAUSED session heartbeat older than 5 minutes', () => {
        const session = makeSession({
            status: 'PAUSED',
            last_heartbeat_at: new Date(Date.now() - 6 * 60_000),
        });
        expect(isSessionFresh(session)).toBe(false);
    });

    it('returns true for an external ACTIVE session with recent last_seen_at (within 15s)', () => {
        const session = makeSession({
            source: 'jellyfin',
            last_seen_at: new Date(Date.now() - 10_000),
        });
        expect(isSessionFresh(session)).toBe(true);
    });

    it('returns false for an external ACTIVE session with stale last_seen_at (>15s)', () => {
        const session = makeSession({
            source: 'jellyfin',
            last_seen_at: new Date(Date.now() - 20_000),
        });
        expect(isSessionFresh(session)).toBe(false);
    });

    it('treats music source as external (uses last_seen_at + 15s threshold)', () => {
        // music source is NOT lumastra — mirrors SessionReadModel behaviour
        const fresh = makeSession({
            source: 'music',
            last_seen_at: new Date(Date.now() - 10_000),
        });
        const stale = makeSession({
            source: 'music',
            last_seen_at: new Date(Date.now() - 20_000),
        });
        expect(isSessionFresh(fresh)).toBe(true);
        expect(isSessionFresh(stale)).toBe(false);
    });
});

describe('serializeJellyfinSession', () => {
    it('converts position_ms to PositionTicks by multiplying by 10000', () => {
        const session = makeSession({ position_ms: 5000 });
        const result = serializeJellyfinSession(session, null);
        expect(result.PlayState.PositionTicks).toBe(50_000_000);
    });

    it('sets IsPaused true when status is PAUSED', () => {
        const session = makeSession({ status: 'PAUSED' });
        const result = serializeJellyfinSession(session, null);
        expect(result.PlayState.IsPaused).toBe(true);
    });

    it('sets IsPaused false when status is ACTIVE', () => {
        const session = makeSession({ status: 'ACTIVE' });
        const result = serializeJellyfinSession(session, null);
        expect(result.PlayState.IsPaused).toBe(false);
    });

    it('sets UserName to the resolved owner_username', () => {
        const session = makeSession({ owner_username: 'alice', owner_display_name: null });
        const result = serializeJellyfinSession(session, null);
        expect(result.UserName).toBe('alice');
    });

    // /j/Users emits `Name: display_name || username`; jellyfin-rpc pairs the two
    // surfaces with `session['UserName'] == user['Name']`, so they must agree.
    it('prefers owner_display_name for UserName so it matches /Users Name', () => {
        const session = makeSession({ owner_username: 'denis', owner_display_name: 'Denis' });
        const result = serializeJellyfinSession(session, null);
        expect(result.UserName).toBe('Denis');
    });

    it('omits NowPlayingItem when item is null', () => {
        const result = serializeJellyfinSession(makeSession(), null);
        expect(result.NowPlayingItem).toBeUndefined();
    });

    it('includes NowPlayingItem when item is provided', () => {
        const fakeItem = {
            Name: 'Test Movie',
            Id: 'abc',
            Type: 'Movie',
        } as never;
        const result = serializeJellyfinSession(makeSession(), fakeItem);
        expect(result.NowPlayingItem).toBe(fakeItem);
    });

    it('strips dashes from session id to produce Id', () => {
        const session = makeSession({
            id: '550e8400-e29b-41d4-a716-446655440000',
        });
        const result = serializeJellyfinSession(session, null);
        expect(result.Id).toBe('550e8400e29b41d4a716446655440000');
    });

    // Must be the users.id UUID as 32-hex — the exact value /j/Users returns as
    // `Id` — so clients that pair the surfaces by UserId resolve the same user.
    it('emits the users.id UUID as UserId, dash-stripped, matching /Users Id', () => {
        const result = serializeJellyfinSession(
            makeSession({ user_id: '42bcfdbf-2647-4591-8c9c-d6120cf15768' }),
            null,
        );
        expect(result.UserId).toBe('42bcfdbf264745918c9cd6120cf15768');
        expect(result.UserId).toHaveLength(32);
    });
});
