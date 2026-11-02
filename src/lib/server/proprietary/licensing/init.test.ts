// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * `initProprietaryLicensing()` is main-process only (Windows new-user e2e
 * 2026-09-27, B1): it starts the licence refresh loop, whose tick writes
 * LICENSE_KEY via saveConfig — a sealed-secret write a plugin-isolation worker
 * (no master key) must never make. In a worker it must be a complete no-op.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
    worker: false,
    registerEntitlementsProvider: vi.fn(),
    registerAiAssistantProvider: vi.fn(),
    registerJellyfinCompatRevocationProvider: vi.fn(),
    startLicenseRefreshLoop: vi.fn(),
    startSilentStartSweeper: vi.fn(),
    registerJellyfinReportBuilder: vi.fn(),
    registerJellyfinResponseObserver: vi.fn(),
    registerJellyfinRemoteControl: vi.fn(),
    streamProxyMode: false,
}));

vi.mock('$lib/server/tasks/isolation/isolation-context.js', async (importOriginal) => {
    const actual =
        await importOriginal<typeof import('$lib/server/tasks/isolation/isolation-context.js')>();
    return { ...actual, isIsolationWorker: () => h.worker };
});
vi.mock('$lib/server/licensing/entitlements.js', () => ({
    registerEntitlementsProvider: h.registerEntitlementsProvider,
}));
vi.mock('$lib/server/ai/assistant-provider.js', () => ({
    registerAiAssistantProvider: h.registerAiAssistantProvider,
}));
vi.mock('$lib/server/auth/jellyfin-compat-revocation.js', () => ({
    registerJellyfinCompatRevocationProvider: h.registerJellyfinCompatRevocationProvider,
}));
vi.mock('$lib/server/compat/jellyfin-report-provider.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/compat/jellyfin-report-provider.js')>()),
    registerJellyfinReportBuilder: h.registerJellyfinReportBuilder,
}));
vi.mock('$lib/server/compat/jellyfin-response-observer.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/compat/jellyfin-response-observer.js')>()),
    registerJellyfinResponseObserver: h.registerJellyfinResponseObserver,
}));
vi.mock('./license.service.js', () => ({ getEntitlements: vi.fn(), getStatus: vi.fn() }));
vi.mock('./license-refresh.js', () => ({
    startLicenseRefreshLoop: h.startLicenseRefreshLoop,
    getLicenseRefreshState: vi.fn(),
}));
vi.mock('../assistant-service.js', () => ({ runAssistant: vi.fn(), resolveUser: vi.fn() }));
vi.mock('../jellyfin-compat/silent-start.js', () => ({
    startSilentStartSweeper: h.startSilentStartSweeper,
}));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => null }));
vi.mock('$lib/server/config.js', () => ({
    config: {
        get STREAM_PROXY_MODE() {
            return h.streamProxyMode;
        },
    },
}));
vi.mock('../jellyfin-compat/auth.js', () => ({ revokeSessionsForUser: vi.fn() }));
vi.mock('../jellyfin-compat/remote-control/register.js', () => ({
    registerJellyfinRemoteControl: h.registerJellyfinRemoteControl,
}));

async function loadInit() {
    vi.resetModules();
    return import('./init.js');
}

beforeEach(() => {
    h.worker = false;
    h.streamProxyMode = false;
    vi.clearAllMocks();
});

describe('initProprietaryLicensing', () => {
    it('is a no-op inside a plugin-isolation worker (no provider, no refresh loop)', async () => {
        h.worker = true;
        const { initProprietaryLicensing } = await loadInit();

        initProprietaryLicensing();

        expect(h.startLicenseRefreshLoop).not.toHaveBeenCalled();
        expect(h.registerEntitlementsProvider).not.toHaveBeenCalled();
        expect(h.registerAiAssistantProvider).not.toHaveBeenCalled();
        expect(h.registerJellyfinCompatRevocationProvider).not.toHaveBeenCalled();
    });

    it('control: on the main thread it registers the provider and starts the loop once', async () => {
        const { initProprietaryLicensing } = await loadInit();

        initProprietaryLicensing();
        initProprietaryLicensing();

        expect(h.registerEntitlementsProvider).toHaveBeenCalledTimes(1);
        expect(h.startLicenseRefreshLoop).toHaveBeenCalledTimes(1);
    });

    it('starts the silent-start sweeper once on a full node', async () => {
        const { initProprietaryLicensing } = await loadInit();

        initProprietaryLicensing();
        initProprietaryLicensing();

        expect(h.startSilentStartSweeper).toHaveBeenCalledTimes(1);
    });

    it('registers the GitHub report builder and the /j response observer on a full node', async () => {
        const { initProprietaryLicensing } = await loadInit();
        const { buildGithubReport } = await import('../jellyfin-compat/github-report.js');
        const { observeJellyfinResponse } =
            await import('../jellyfin-compat/contract/runtime-hook.js');

        initProprietaryLicensing();

        expect(h.registerJellyfinReportBuilder).toHaveBeenCalledTimes(1);
        expect(h.registerJellyfinReportBuilder).toHaveBeenCalledWith(buildGithubReport);
        expect(h.registerJellyfinResponseObserver).toHaveBeenCalledTimes(1);
        expect(h.registerJellyfinResponseObserver).toHaveBeenCalledWith(observeJellyfinResponse);
    });

    it('does not start the sweeper on a stream-proxy-only node, nor in a worker', async () => {
        h.streamProxyMode = true;
        const { initProprietaryLicensing } = await loadInit();
        initProprietaryLicensing();
        expect(h.startSilentStartSweeper).not.toHaveBeenCalled();

        h.streamProxyMode = false;
        h.worker = true;
        const again = await loadInit();
        again.initProprietaryLicensing();
        expect(h.startSilentStartSweeper).not.toHaveBeenCalled();
    });

    it('registers /j remote control (the /j/socket upgrade) on a full node only', async () => {
        const { initProprietaryLicensing } = await loadInit();
        initProprietaryLicensing();
        await vi.waitFor(() => expect(h.registerJellyfinRemoteControl).toHaveBeenCalledTimes(1));

        h.streamProxyMode = true;
        const proxy = await loadInit();
        proxy.initProprietaryLicensing();
        h.streamProxyMode = false;
        h.worker = true;
        const worker = await loadInit();
        worker.initProprietaryLicensing();
        await new Promise((r) => setTimeout(r, 20));
        expect(h.registerJellyfinRemoteControl).toHaveBeenCalledTimes(1);
    });
});
