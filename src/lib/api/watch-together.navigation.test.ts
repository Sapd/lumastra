// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
const { monitoredFetch } = vi.hoisted(() => ({ monitoredFetch: vi.fn() }));
vi.mock('$app/environment', () => ({ browser: false, dev: false }));
vi.mock('$lib/auth-monitor.js', () => ({ monitoredFetch, handleAuthExpiration: vi.fn() }));
import { broadcastNavigate } from './watch-together';

beforeEach(() => {
    monitoredFetch.mockReset();
});

describe('navigation acknowledgement over the typed HTTP client', () => {
    it.each([72.546, undefined])(
        'retains entry %s and accepts legacy acknowledgements',
        async (entry) => {
            monitoredFetch.mockResolvedValue(
                new Response(JSON.stringify({ accepted: true, currentTime: entry }), {
                    status: 202,
                    headers: { 'content-type': 'application/json' },
                }),
            );
            const body = {
                clientId: 'host',
                itemId: 'episode-two',
                title: 'Part two',
                mediaType: 'episode' as const,
                timelineId: 'new',
                expectedTimelineId: 'old',
            };
            const result = await broadcastNavigate('ABC123', body);
            expect(result.error).toBeNull();
            expect(result.data?.currentTime).toBe(entry);
            expect(monitoredFetch.mock.calls[0][0]).toBe('/api/watch-together/ABC123/events');
            const request = monitoredFetch.mock.calls[0][1] as RequestInit;
            expect(request.method).toBe('POST');
            expect(JSON.parse(String(request.body))).toEqual({
                clientId: 'host',
                type: 'navigate',
                payload: {
                    itemId: 'episode-two',
                    title: 'Part two',
                    mediaType: 'episode',
                    timelineId: 'new',
                    expectedTimelineId: 'old',
                },
            });
        },
    );
});
