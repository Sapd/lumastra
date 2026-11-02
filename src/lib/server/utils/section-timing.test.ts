// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { timeSection } from './section-timing';

// Mock the Logger's console output by mocking the underlying winston logger
vi.mock('$lib/server/utils/logger', () => {
    const mockLogger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    };
    return {
        Logger: {
            for: vi.fn(() => mockLogger),
            __mockLogger: mockLogger,
        },
    };
});

// Import after mocking to get the mock
import { Logger } from '$lib/server/utils/logger';

describe('timeSection', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    test('returns the resolved value unchanged', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mockLogger = (Logger as any).__mockLogger;
        mockLogger.warn.mockClear();

        const result = await timeSection('recently-played', 't1', async () => {
            return [{ id: 'a' }, { id: 'b' }];
        });
        expect(result).toEqual([{ id: 'a' }, { id: 'b' }]);
        expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    test('logs section, tier, duration_ms, ok=true on success', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mockLogger = (Logger as any).__mockLogger;
        mockLogger.info.mockClear();

        await timeSection('quick-picks', 't2', async () => {
            await new Promise((r) => setTimeout(r, 5));
            return 'ok';
        });

        expect(mockLogger.info).toHaveBeenCalledTimes(1);
        const [msg, fields] = mockLogger.info.mock.calls[0];
        expect(msg).toBe('section.timing');
        expect(fields).toMatchObject({
            section: 'quick-picks',
            tier: 't2',
            ok: true,
        });
        expect(fields).toHaveProperty('duration_ms');
        expect(typeof fields.duration_ms).toBe('number');
        expect(fields.duration_ms).toBeGreaterThanOrEqual(0);
    });

    test('rethrows the original error', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mockLogger = (Logger as any).__mockLogger;
        mockLogger.warn.mockClear();
        mockLogger.info.mockClear();

        const err = new Error('boom');
        await expect(
            timeSection('byl', 't2', async () => {
                throw err;
            }),
        ).rejects.toBe(err);
        expect(mockLogger.warn).toHaveBeenCalledTimes(1);
        expect(mockLogger.info).not.toHaveBeenCalled();
    });

    test('logs ok=false with error message on rejection', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mockLogger = (Logger as any).__mockLogger;
        mockLogger.warn.mockClear();

        await timeSection('byl', 't2', async () => {
            throw new Error('db down');
        }).catch(() => undefined);

        expect(mockLogger.warn).toHaveBeenCalledTimes(1);
        const [msg, fields] = mockLogger.warn.mock.calls[0];
        expect(msg).toBe('section.timing');
        expect(fields).toMatchObject({
            section: 'byl',
            tier: 't2',
            ok: false,
            error: 'db down',
        });
    });
});
