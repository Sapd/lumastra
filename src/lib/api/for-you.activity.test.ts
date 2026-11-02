// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('$app/environment', () => ({ browser: false, dev: false }));
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('$lib/auth-monitor.js', () => ({
    monitoredFetch: fetchMock,
    handleAuthExpiration: vi.fn(),
}));
vi.mock('./contract-reporter.js', () => ({ reportApiContractMismatch: vi.fn() }));
vi.mock('$lib/client-diagnostics/web-reporter.js', () => ({ reportApiFailure: vi.fn() }));
import { getAudiobookActivityFeed } from './for-you.js';
import { setApiContractStrictForTests } from './client.js';

const item = {
    author: {
        userId: '550e8400-e29b-41d4-a716-446655440001',
        displayName: null,
        images: {
            primary: { href: '/api/users/alex/images/primary', revision: '1', source: 'generated' },
        },
    },
    media: {
        id: '550e8400-e29b-41d4-a716-446655440002',
        catalogId: '550e8400-e29b-41d4-a716-446655440002',
        type: 'audiobook',
        ids: {},
        title: 'A Book',
        images: {},
        audiobook: { authors: [], narrators: [], series: null },
    },
    kind: 'listened',
    listenedMinutes: 15,
    occurredOn: '2026-10-23',
    approximate: true,
};
function payload(items: unknown[]) {
    return {
        sections: [
            {
                type: 'audiobook-activity',
                id: 'audiobook-activity',
                title: 'Listening in your circle',
                items,
                source: { href: '/api/feed?sections=audiobook-activity' },
            },
        ],
    };
}
function respond(body: unknown): void {
    fetchMock.mockResolvedValue(
        new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
    );
}
beforeEach(() => {
    vi.clearAllMocks();
    // Exercise production behavior: this request must fail closed on its own.
    setApiContractStrictForTests(false);
});
afterEach(() => {
    setApiContractStrictForTests(undefined);
});

describe('dashboard activity feed client contract', () => {
    it('accepts production-shaped rich activity and preserves every social field', async () => {
        respond(payload([item]));
        const result = await getAudiobookActivityFeed();
        expect(result.error).toBeNull();
        expect(result.data).toEqual(payload([item]));
        expect(fetchMock.mock.calls[0][0]).toContain('sections=audiobook-activity');
    });
    it('accepts finished activity without a listening duration', async () => {
        const { listenedMinutes: _minutes, ...finished } = { ...item, kind: 'finished' };
        respond(payload([finished]));
        expect((await getAudiobookActivityFeed()).data).toEqual(payload([finished]));
    });
    it('accepts an absent optional rail', async () => {
        respond({ sections: [] });
        expect((await getAudiobookActivityFeed()).data).toEqual({ sections: [] });
    });
    it.each(['author', 'media', 'kind', 'occurredOn', 'approximate'])(
        'fails closed when required %s is missing, even if caller opts out of strictness',
        async (field) => {
            const malformed: Record<string, unknown> = { ...item };
            delete malformed[field];
            respond(payload([malformed]));
            const result = await getAudiobookActivityFeed({ strict: false });
            expect(result.data).toBeNull();
            expect(result.error).toBeTruthy();
            expect(result.validationError).toBeDefined();
        },
    );
    it('rejects the flat public preview shape before it can reach the activity renderer', async () => {
        respond(payload([{ ...item.media, reason: { kind: 'listened', label: 'Alex' } }]));
        const result = await getAudiobookActivityFeed();
        expect(result.data).toBeNull();
        expect(result.error).toBeTruthy();
    });
});
