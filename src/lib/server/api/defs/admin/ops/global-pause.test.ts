// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Two kinds of coverage in this file:
 *  - `inWindow` — pure-logic coverage of the quiet-hours window check (the
 *    whole "should heavy work be paused right now" decision).
 *  - POST/DELETE handler coverage of the audit-actor vs. `pausedBy`
 *    distinction (fix round 1, R5) — see the describe blocks below.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { inWindow } from './global-pause.js';

// ── Audit actor vs. pausedBy data field (fix round 1, R5) ──────────────────
//
// The audit trail must carry a human-readable username (via auditActor()),
// while GlobalPauseRecord.pausedBy — a DATA field, not an audit field — stays
// on the users.id UUID deliberately (see global-pause.ts's actorId() doc
// comment). These two must NOT be conflated.
const mockAuditLog = vi.fn();
vi.mock('$lib/server/utils/audit-log.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/utils/audit-log.js')>();
    return { ...actual, auditLog: (...a: unknown[]) => mockAuditLog(...a) };
});

const mockReconcileAndReadStatus = vi.fn();
const mockReadGlobalPause = vi.fn();
const mockWriteGlobalPause = vi.fn();
const mockClearGlobalPause = vi.fn();
const mockPauseClasses = vi.fn();
const mockResumeClasses = vi.fn();
// `importOriginal` + spread so the REAL `inWindow` (re-exported by
// global-pause.ts, and exercised by the pure-logic `describe('inWindow')`
// block below) keeps working — only the state-touching functions are
// stubbed.
vi.mock('$lib/server/tasks/global-pause-reconcile.js', async (importOriginal) => {
    const actual =
        await importOriginal<typeof import('$lib/server/tasks/global-pause-reconcile.js')>();
    return {
        ...actual,
        reconcileAndReadStatus: (...a: unknown[]) => mockReconcileAndReadStatus(...a),
        readGlobalPause: (...a: unknown[]) => mockReadGlobalPause(...a),
        writeGlobalPause: (...a: unknown[]) => mockWriteGlobalPause(...a),
        clearGlobalPause: (...a: unknown[]) => mockClearGlobalPause(...a),
        pauseClasses: (...a: unknown[]) => mockPauseClasses(...a),
        resumeClasses: (...a: unknown[]) => mockResumeClasses(...a),
    };
});

vi.mock('$lib/server/tasks/connection.js', () => ({
    getQueueConnectionOptions: () => ({ host: 'localhost', port: 6379, db: 0 }),
}));

const { def } = await import('./global-pause.js');

const PRINCIPAL_USER_ID = '11111111-1111-4111-8111-111111111111';

function makeEvent(): RequestEvent {
    return {
        request: new Request('http://localhost/test', {
            method: 'POST',
            body: JSON.stringify({ durationHours: 2 }),
        }),
        locals: {
            principal: {
                userId: PRINCIPAL_USER_ID,
                username: 'alice',
                kind: 'pat',
                credentialId: 'pat-1',
            },
        },
    } as unknown as RequestEvent;
}

beforeEach(() => {
    vi.clearAllMocks();
    mockReconcileAndReadStatus.mockResolvedValue({
        quietHours: { enabled: false, start: '', end: '', active: false },
    });
    mockReadGlobalPause.mockResolvedValue(null);
    mockPauseClasses.mockImplementation(async (classes: string[]) => classes);
});

describe('POST /admin/ops/global-pause — audit actor vs. pausedBy', () => {
    it('audits the human-readable username, kind and credentialId — not the userId UUID', async () => {
        const event = makeEvent();
        await def.handlers.POST!(event, {} as never);

        const call = mockAuditLog.mock.calls.find((c) => c[0] === 'queue.pause.global');
        expect(call).toBeDefined();
        expect(call?.[2]).toEqual({ username: 'alice', kind: 'pat', credentialId: 'pat-1' });
    });

    it('still stores the userId UUID in the pausedBy DATA field — unchanged', async () => {
        const event = makeEvent();
        await def.handlers.POST!(event, {} as never);

        expect(mockWriteGlobalPause).toHaveBeenCalledWith(
            expect.objectContaining({ pausedBy: PRINCIPAL_USER_ID }),
            expect.any(Number),
        );
    });
});

describe('DELETE /admin/ops/global-pause — audit actor', () => {
    it('audits the human-readable username, kind and credentialId — not the userId UUID', async () => {
        mockReadGlobalPause.mockResolvedValue({
            resumeAt: new Date().toISOString(),
            classes: ['cpu'],
            pausedBy: PRINCIPAL_USER_ID,
            pausedAt: new Date().toISOString(),
        });
        const event = makeEvent();
        await def.handlers.DELETE!(event, {} as never);

        const call = mockAuditLog.mock.calls.find((c) => c[0] === 'queue.resume.global');
        expect(call).toBeDefined();
        expect(call?.[2]).toEqual({ username: 'alice', kind: 'pat', credentialId: 'pat-1' });
    });
});

describe('inWindow', () => {
    it('is inside a same-day window', () => {
        expect(inWindow('03:00', '01:00', '07:00')).toBe(true);
    });

    it('is outside a same-day window before it starts', () => {
        expect(inWindow('00:30', '01:00', '07:00')).toBe(false);
    });

    it('is outside a same-day window after it ends', () => {
        expect(inWindow('07:00', '01:00', '07:00')).toBe(false); // end is exclusive
    });

    it('wraps past midnight when end <= start', () => {
        // 22:00–06:00: late night and early morning are both "inside".
        expect(inWindow('23:30', '22:00', '06:00')).toBe(true);
        expect(inWindow('02:00', '22:00', '06:00')).toBe(true);
    });

    it('is outside a wrapped window in the middle of the day', () => {
        expect(inWindow('14:00', '22:00', '06:00')).toBe(false);
    });

    it('treats an equal start and end as always off', () => {
        expect(inWindow('12:00', '05:00', '05:00')).toBe(false);
    });
});
