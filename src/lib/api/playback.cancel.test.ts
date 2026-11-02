// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockApiDelete = vi.fn();
vi.mock('$lib/api/client', () => ({
    apiDelete: (...a: unknown[]) => mockApiDelete(...a),
    apiGet: vi.fn(),
}));

import { cancelSession } from './playback.js';

beforeEach(() => vi.clearAllMocks());

describe('cancelSession', () => {
    it('DELETEs the addressed internal session with the session id', async () => {
        mockApiDelete.mockResolvedValue({ data: null, error: null });
        await cancelSession('sess-42');
        expect(mockApiDelete).toHaveBeenCalledTimes(1);
        expect(mockApiDelete.mock.calls[0][0]).toBe('/api/play-sessions/sess-42');
    });
});
