// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * `initProprietaryLicensing()` is main-process only (Windows new-user e2e
 * 2026-09-27, B1): it starts the licence refresh loop, whose tick writes
 * LICENSE_KEY via saveConfig — a sealed-secret write a plugin-isolation worker
 * (no master key) must never make. In a worker it must be a complete no-op.
 *
 * The /j, assistant and sweeper registrations moved to boot/compat-init.ts
 * (tested there); init only asks it to run, before it starts the licence loop.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
    worker: false,
    order: [] as string[],
    registerEntitlementsProvider: vi.fn(),
    startLicenseRefreshLoop: vi.fn(),
    ensureCompatLoaded: vi.fn(),
}));

vi.mock('$lib/server/tasks/isolation/isolation-context.js', async (importOriginal) => {
    const actual =
        await importOriginal<typeof import('$lib/server/tasks/isolation/isolation-context.js')>();
    return { ...actual, isIsolationWorker: () => h.worker };
});
vi.mock('$lib/server/licensing/entitlements.js', () => ({
    registerEntitlementsProvider: h.registerEntitlementsProvider,
}));
vi.mock('$lib/server/boot/compat-init.js', () => ({
    ensureCompatLoaded: (...a: unknown[]) => {
        h.order.push('compat');
        return h.ensureCompatLoaded(...a);
    },
}));
vi.mock('./license.service.js', () => ({ getEntitlements: vi.fn(), getStatus: vi.fn() }));
vi.mock('./license-refresh.js', () => ({
    startLicenseRefreshLoop: (...a: unknown[]) => {
        h.order.push('licence-loop');
        return h.startLicenseRefreshLoop(...a);
    },
    getLicenseRefreshState: vi.fn(),
}));

async function loadInit() {
    vi.resetModules();
    return import('./init.js');
}

beforeEach(() => {
    h.worker = false;
    h.order = [];
    vi.clearAllMocks();
});

describe('initProprietaryLicensing', () => {
    it('is a no-op inside a plugin-isolation worker (no provider, no refresh loop)', async () => {
        h.worker = true;
        const { initProprietaryLicensing } = await loadInit();

        initProprietaryLicensing();

        expect(h.startLicenseRefreshLoop).not.toHaveBeenCalled();
        expect(h.registerEntitlementsProvider).not.toHaveBeenCalled();
        expect(h.ensureCompatLoaded).not.toHaveBeenCalled();
    });

    it('control: on the main thread it registers the provider and starts the loop once', async () => {
        const { initProprietaryLicensing } = await loadInit();

        initProprietaryLicensing();
        initProprietaryLicensing();

        expect(h.registerEntitlementsProvider).toHaveBeenCalledTimes(1);
        expect(h.startLicenseRefreshLoop).toHaveBeenCalledTimes(1);
    });

    it('asks the boot loader first, so the relay token enrolment owns minting before the licence loop ticks', async () => {
        const { initProprietaryLicensing } = await loadInit();

        initProprietaryLicensing();

        expect(h.ensureCompatLoaded).toHaveBeenCalledTimes(1);
        expect(h.order).toEqual(['compat', 'licence-loop']);
    });
});
