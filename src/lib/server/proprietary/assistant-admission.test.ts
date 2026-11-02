// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const ai = vi.hoisted(() => ({
    assistantRequestsPerMinute: 10 as number | undefined,
    assistantMaxConcurrent: 2 as number | undefined,
}));
vi.mock('$lib/server/config/domains/ai.js', () => ({ getAiConfig: () => ai }));

const checkRateLimit = vi.fn();
vi.mock('$lib/server/middleware/valkey-rate-limit', () => ({
    checkRateLimit: (...a: unknown[]) => checkRateLimit(...a),
}));

// An in-memory stand-in for the sorted-set slot helpers (same contract as the
// real ones: capped, idempotent release, individually expiring members).
const slots = new Map<string, Set<string>>();
const zAddBoundedExpiring = vi.fn(
    async (key: string, member: string, cap: number, _ttl: number, _o: { failOpen: boolean }) => {
        const set = slots.get(key) ?? new Set<string>();
        slots.set(key, set);
        if (!set.has(member) && set.size >= cap) return false;
        set.add(member);
        return true;
    },
);
const zRem = vi.fn(async (key: string, member: string) => {
    return slots.get(key)?.delete(member) ? 1 : 0;
});
vi.mock('$lib/server/cache/valkey', () => ({
    zAddBoundedExpiring: (...a: Parameters<typeof zAddBoundedExpiring>) =>
        zAddBoundedExpiring(...a),
    zRem: (...a: Parameters<typeof zRem>) => zRem(...a),
}));

const warn = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/utils/logger', () => ({
    Logger: { for: () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

const { admitAssistantRun, AssistantAdmissionError } = await import('./assistant-admission.js');

beforeEach(() => {
    vi.clearAllMocks();
    slots.clear();
    ai.assistantRequestsPerMinute = 10;
    ai.assistantMaxConcurrent = 2;
    checkRateLimit.mockResolvedValue({
        allowed: true,
        remaining: 9,
        resetAt: 1_900_000_060,
        total: 10,
    });
});

describe('admitAssistantRun', () => {
    it('keys both limits by user and fails the slot open on a cache outage', async () => {
        const ticket = await admitAssistantRun('u1');
        expect(checkRateLimit).toHaveBeenCalledWith('assistant-rpm:u1', 10, 60);
        expect(zAddBoundedExpiring.mock.calls[0][0]).toBe('assistant:slots:u1');
        expect(zAddBoundedExpiring.mock.calls[0][4]).toEqual({ failOpen: true });
        await ticket.release();
    });

    it('refuses over the per-minute limit and reports when the window resets', async () => {
        checkRateLimit.mockResolvedValue({
            allowed: false,
            remaining: 0,
            resetAt: 1_900_000_060,
            total: 10,
        });
        const err = await admitAssistantRun('u1').catch((e: unknown) => e);
        expect(err).toBeInstanceOf(AssistantAdmissionError);
        expect((err as InstanceType<typeof AssistantAdmissionError>).kind).toBe('rate_limited');
        expect((err as InstanceType<typeof AssistantAdmissionError>).resetAt).toBe(1_900_000_060);
        expect(zAddBoundedExpiring).not.toHaveBeenCalled();
    });

    it('refuses over the concurrency cap, and a release frees exactly one slot', async () => {
        const a = await admitAssistantRun('u1');
        await admitAssistantRun('u1');
        const err = await admitAssistantRun('u1').catch((e: unknown) => e);
        expect((err as InstanceType<typeof AssistantAdmissionError>).kind).toBe(
            'too_many_concurrent',
        );
        await a.release();
        await a.release(); // double release must not free a second slot
        await admitAssistantRun('u1');
        const again = await admitAssistantRun('u1').catch((e: unknown) => e);
        expect(again).toBeInstanceOf(AssistantAdmissionError);
        expect(slots.get('assistant:slots:u1')!.size).toBe(2);
    });

    it('keeps the slot of a run longer than the slot TTL (heartbeat re-adds the same member)', async () => {
        vi.useFakeTimers();
        try {
            const ticket = await admitAssistantRun('u1');
            const member = zAddBoundedExpiring.mock.calls[0][1];
            await vi.advanceTimersByTimeAsync(250_000);
            const beats = zAddBoundedExpiring.mock.calls.filter((c) => c[1] === member);
            expect(beats.length).toBeGreaterThanOrEqual(3);
            await ticket.release();
            const before = zAddBoundedExpiring.mock.calls.length;
            await vi.advanceTimersByTimeAsync(300_000);
            expect(zAddBoundedExpiring.mock.calls.length).toBe(before); // heartbeat stopped
        } finally {
            vi.useRealTimers();
        }
    });

    it('applies no limit when none is configured', async () => {
        ai.assistantRequestsPerMinute = undefined;
        ai.assistantMaxConcurrent = undefined;
        await admitAssistantRun('u1');
        expect(checkRateLimit).not.toHaveBeenCalled();
        expect(zAddBoundedExpiring).not.toHaveBeenCalled();
    });

    it('replaces an invalid limit with the schema default and warns', async () => {
        ai.assistantRequestsPerMinute = Number.NaN;
        ai.assistantMaxConcurrent = -3;
        await admitAssistantRun('u1');
        expect(checkRateLimit).toHaveBeenCalledWith('assistant-rpm:u1', 10, 60);
        expect(zAddBoundedExpiring.mock.calls[0][2]).toBe(2);
        expect(warn).toHaveBeenCalledTimes(2);
    });

    it('keeps an explicit 0 as deny, as the route did', async () => {
        ai.assistantMaxConcurrent = 0;
        const err = await admitAssistantRun('u1').catch((e: unknown) => e);
        expect((err as InstanceType<typeof AssistantAdmissionError>).kind).toBe(
            'too_many_concurrent',
        );
        ai.assistantMaxConcurrent = 2;
        ai.assistantRequestsPerMinute = 0;
        checkRateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetAt: 1, total: 0 });
        const err2 = await admitAssistantRun('u1').catch((e: unknown) => e);
        expect((err2 as InstanceType<typeof AssistantAdmissionError>).kind).toBe('rate_limited');
        expect(checkRateLimit).toHaveBeenCalledWith('assistant-rpm:u1', 0, 60);
    });
});
