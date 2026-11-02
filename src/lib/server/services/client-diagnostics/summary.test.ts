// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { summaryFor } from './summary.js';

describe('summaryFor compat_incident', () => {
    it('falls back to "unknown" for an empty payload', () => {
        expect(summaryFor('compat_incident', {})).toBe(
            'Jellyfin client: playback never started (unknown)',
        );
    });
    it('omits a missing clientName without a dangling space', () => {
        expect(summaryFor('compat_incident', { clientVersion: '1.2' })).toBe(
            'Jellyfin client: playback never started (1.2)',
        );
    });
    it('ignores non-string values', () => {
        expect(summaryFor('compat_incident', { clientName: 5, clientVersion: { a: 1 } })).toBe(
            'Jellyfin client: playback never started (unknown)',
        );
    });
    it('joins name and version', () => {
        expect(
            summaryFor('compat_incident', { clientName: 'Findroid', clientVersion: '0.15' }),
        ).toBe('Jellyfin client: playback never started (Findroid 0.15)');
    });
});

it('appends the decode path when present', () => {
    const payload = { method: 'GET', route: '/api/items', outcome: 'decode', status: 200 };
    expect(summaryFor('api_failures', payload)).toBe('GET /api/items → decode 200');
    expect(summaryFor('api_failures', { ...payload, keyPath: 'items.3.url' })).toBe(
        'GET /api/items → decode 200 @ items.3.url',
    );
});

it('summarises a failure the user saw with the call behind it', () => {
    expect(
        summaryFor('js_error', {
            origin: 'error_toast',
            toastKey: 'audiobook_session_failed',
            cause: { method: 'POST', route: '/api/v1/play-sessions', status: 502 },
        }),
    ).toBe('Failure shown: audiobook_session_failed ← POST /api/v1/play-sessions 502');
    expect(summaryFor('js_error', { origin: 'error_toast' })).toBe('Failure shown: untagged');
    expect(
        summaryFor('api_failures', {
            method: 'GET',
            route: '/api/x',
            outcome: 'status_5xx',
            status: 502,
            problemCode: 'bad_gateway',
        }),
    ).toBe('GET /api/x → status_5xx 502 bad_gateway');
});
