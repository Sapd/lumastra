// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Client-side handling of `event: admin` frames.
 *
 * The interesting behaviour is the TARGETING filter. `/api/v1/events` is a
 * per-user stream: one account with two signed-in clients has both connections
 * fed the same frames, and the server cannot tell them apart. So a targeted
 * `admin_message` names its target and the client decides — which makes this
 * filter, not the server, the thing that stops a message for the living-room TV
 * from also toasting the bedroom one.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const toasts = {
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
};

const maintenanceNotice = {
    set: vi.fn(),
    clear: vi.fn(),
};

vi.mock('$lib/stores/toast.store.js', () => ({ toasts }));
vi.mock('$lib/stores/maintenance-notice.store.svelte.js', () => ({ maintenanceNotice }));

const { handleAdminEvent } = await import('./admin-event-handler.js');

/** A fresh id per frame so the module's dedupe cache never crosses tests. */
let seq = 0;
function message(overrides: Record<string, unknown> = {}) {
    seq += 1;
    return {
        type: 'admin_message',
        id: `msg-${seq}`,
        message: 'Restarting shortly',
        severity: 'info',
        sentBy: 'testuser',
        sentAt: Date.now(),
        ...overrides,
    };
}

function toastCount(): number {
    return (
        toasts.info.mock.calls.length +
        toasts.warning.mock.calls.length +
        toasts.error.mock.calls.length
    );
}

beforeEach(() => {
    vi.clearAllMocks();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('targeting', () => {
    it('renders an untargeted message on every client', () => {
        handleAdminEvent(message(), { deviceId: 'device-a' });
        expect(toasts.info).toHaveBeenCalledTimes(1);
    });

    it('renders a play-session-targeted message only on the matching session', () => {
        handleAdminEvent(message({ playSessionId: 'sess-1' }), { playSessionId: 'sess-1' });
        expect(toastCount()).toBe(1);

        handleAdminEvent(message({ playSessionId: 'sess-1' }), { playSessionId: 'sess-2' });
        expect(toastCount()).toBe(1);
    });

    it('renders a device-targeted message only on the matching device', () => {
        handleAdminEvent(message({ deviceId: 'device-a' }), { deviceId: 'device-a' });
        expect(toastCount()).toBe(1);

        handleAdminEvent(message({ deviceId: 'device-a' }), { deviceId: 'device-b' });
        expect(toastCount()).toBe(1);
    });

    it('matches on deviceId when the listener does not know its play session', () => {
        // This is the app-wide listener's situation: it knows the browser's
        // device id but not which play session (if any) is running.
        handleAdminEvent(message({ playSessionId: 'sess-1', deviceId: 'device-a' }), {
            deviceId: 'device-a',
        });
        expect(toastCount()).toBe(1);
    });

    it('drops a targeted message when the client can identify itself as neither', () => {
        // Addressed to one specific client; showing it to an unidentifiable one
        // is exactly the failure the target fields exist to prevent.
        handleAdminEvent(message({ playSessionId: 'sess-1' }), {});
        handleAdminEvent(message({ playSessionId: 'sess-1' }));
        expect(toastCount()).toBe(0);
    });

    it('does not let a non-matching client burn the dedupe id', () => {
        // Both channels see every frame. If the listener that filters a frame
        // OUT still recorded its id, the channel that is the right target would
        // then see it as a duplicate and drop it as well — the message would
        // reach nobody.
        const frame = message({ playSessionId: 'sess-1' });
        handleAdminEvent(frame, { playSessionId: 'sess-2' });
        expect(toastCount()).toBe(0);
        handleAdminEvent(frame, { playSessionId: 'sess-1' });
        expect(toastCount()).toBe(1);
    });
});

describe('severity', () => {
    it('maps the known values to their toast kinds', () => {
        handleAdminEvent(message({ severity: 'error' }));
        expect(toasts.error).toHaveBeenCalledTimes(1);
        handleAdminEvent(message({ severity: 'warning' }));
        expect(toasts.warning).toHaveBeenCalledTimes(1);
        handleAdminEvent(message({ severity: 'info' }));
        expect(toasts.info).toHaveBeenCalledTimes(1);
    });

    it('shows an unknown severity as info rather than swallowing the message', () => {
        // Severity is advisory: it picks a colour and must never decide whether
        // the message is shown. A server that adds a fourth value must not
        // silence clients built against three.
        handleAdminEvent(message({ severity: 'catastrophic' }));
        handleAdminEvent(message({ severity: undefined }));
        expect(toasts.info).toHaveBeenCalledTimes(2);
        expect(toastCount()).toBe(2);
    });
});

describe('staleness and dedupe', () => {
    it('drops a message older than the staleness window', () => {
        handleAdminEvent(message({ sentAt: Date.now() - 120_000 }));
        expect(toastCount()).toBe(0);
    });

    it('shows one toast when the same frame arrives on both channels', () => {
        const frame = message();
        handleAdminEvent(frame, { playSessionId: 'sess-1' });
        handleAdminEvent(frame, { deviceId: 'device-a' });
        expect(toastCount()).toBe(1);
    });
});

describe('maintenance frames', () => {
    it('sets the notice store from a maintenance_notice frame', () => {
        handleAdminEvent({
            type: 'maintenance_notice',
            id: 'notice-1',
            message: 'Scheduled maintenance',
            endsAt: 1757665800000,
            endsAtIso: '2026-09-12T10:30:00.000Z',
            remainingMs: 1_800_000,
            createdBy: 'testuser',
            createdAt: 1757664000000,
        });
        expect(maintenanceNotice.set).toHaveBeenCalledWith({
            id: 'notice-1',
            message: 'Scheduled maintenance',
            endsAt: 1757665800000,
            createdBy: 'testuser',
            createdAt: 1757664000000,
        });
    });

    it('clears on maintenance_cleared', () => {
        handleAdminEvent({ type: 'maintenance_cleared' });
        expect(maintenanceNotice.clear).toHaveBeenCalledTimes(1);
    });

    it('ignores maintenance targeting context — a notice is always global', () => {
        // A maintenance notice carries no target and applies to everyone, so
        // the filter must not be reached for it at all.
        handleAdminEvent(
            {
                type: 'maintenance_cleared',
            },
            { playSessionId: 'sess-nonexistent' },
        );
        expect(maintenanceNotice.clear).toHaveBeenCalledTimes(1);
    });

    it('ignores a frame with an unrecognised type', () => {
        handleAdminEvent({ type: 'something_new' });
        handleAdminEvent(null);
        handleAdminEvent('not an object');
        expect(toastCount()).toBe(0);
        expect(maintenanceNotice.set).not.toHaveBeenCalled();
        expect(maintenanceNotice.clear).not.toHaveBeenCalled();
    });
});
