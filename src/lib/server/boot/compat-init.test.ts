// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The boot loader fills every registry once per process, never inside a
 * plugin-isolation worker, and starts the relay token enrolment loop only for
 * the processes that ask for it.
 *
 * "Process types" here: web (hooks.server.ts), worker / task runtime
 * (task-runtime/index.ts, executor-child.ts), a stream-proxy-only node, and the
 * plugin-isolation worker. The second test group pins that each real entry point
 * really calls the loader.
 */

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
    worker: false,
    streamProxyMode: false,
    registerAiAssistantProvider: vi.fn(),
    registerJellyfinCompatRevocationProvider: vi.fn(),
    registerJellyfinResponseObserver: vi.fn(),
    registerJellyfinReportBuilder: vi.fn(),
    registerJellyfinRemoteControl: vi.fn(),
    startSilentStartSweeper: vi.fn(),
    startRelayTokenEnrolLoop: vi.fn(),
    runAssistant: vi.fn(),
    resolveUser: vi.fn(),
    revokeSessionsForUser: vi.fn(),
    observeJellyfinResponse: vi.fn(),
    buildGithubReport: vi.fn(),
}));

vi.mock('$lib/server/tasks/isolation/isolation-context.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/tasks/isolation/isolation-context.js')>()),
    isIsolationWorker: () => h.worker,
}));
vi.mock('$lib/server/config.js', () => ({
    config: {
        get STREAM_PROXY_MODE() {
            return h.streamProxyMode;
        },
    },
}));
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ info() {}, warn() {}, error() {}, debug() {} }) },
}));
vi.mock('$lib/server/services/push/relay-token-enrol.js', () => ({
    startRelayTokenEnrolLoop: h.startRelayTokenEnrolLoop,
}));
vi.mock('$lib/server/ai/assistant-provider.js', () => ({
    registerAiAssistantProvider: h.registerAiAssistantProvider,
}));
vi.mock('$lib/server/proprietary/assistant-service.js', () => ({
    runAssistant: h.runAssistant,
    resolveUser: h.resolveUser,
}));
vi.mock('$lib/server/auth/jellyfin-compat-revocation.js', () => ({
    registerJellyfinCompatRevocationProvider: h.registerJellyfinCompatRevocationProvider,
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/auth.js', () => ({
    revokeSessionsForUser: h.revokeSessionsForUser,
}));
vi.mock('$lib/server/compat/jellyfin-response-observer.js', () => ({
    registerJellyfinResponseObserver: h.registerJellyfinResponseObserver,
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/contract/runtime-hook.js', () => ({
    observeJellyfinResponse: h.observeJellyfinResponse,
}));
vi.mock('$lib/server/compat/jellyfin-report-provider.js', () => ({
    registerJellyfinReportBuilder: h.registerJellyfinReportBuilder,
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/github-report.js', () => ({
    buildGithubReport: h.buildGithubReport,
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/silent-start.js', () => ({
    startSilentStartSweeper: h.startSilentStartSweeper,
}));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => null }));
vi.mock('$lib/server/proprietary/jellyfin-compat/remote-control/register.js', () => ({
    registerJellyfinRemoteControl: h.registerJellyfinRemoteControl,
}));

async function load() {
    vi.resetModules();
    return import('./compat-init.js');
}

beforeEach(() => {
    h.worker = false;
    h.streamProxyMode = false;
    vi.clearAllMocks();
});

describe('ensureCompatLoaded', () => {
    it('web / task runtime: registers every provider and starts the enrolment loop, once', async () => {
        const { ensureCompatLoaded } = await load();

        await ensureCompatLoaded({ enrolRelayToken: true });
        await ensureCompatLoaded({ enrolRelayToken: true });

        expect(h.registerAiAssistantProvider).toHaveBeenCalledTimes(1);
        const provider = h.registerAiAssistantProvider.mock.calls[0]![0] as {
            runAssistant: (i: unknown, d: unknown) => unknown;
            resolveUser: unknown;
        };
        expect(provider.resolveUser).toBe(h.resolveUser);
        provider.runAssistant({ message: 'x' }, { user: 'u' });
        expect(h.runAssistant).toHaveBeenCalledWith({ message: 'x' }, { user: 'u' });

        expect(h.registerJellyfinCompatRevocationProvider).toHaveBeenCalledTimes(1);
        expect(h.registerJellyfinCompatRevocationProvider).toHaveBeenCalledWith({
            revokeSessionsForUser: h.revokeSessionsForUser,
        });
        expect(h.registerJellyfinResponseObserver).toHaveBeenCalledWith(h.observeJellyfinResponse);
        expect(h.registerJellyfinResponseObserver).toHaveBeenCalledTimes(1);
        expect(h.registerJellyfinReportBuilder).toHaveBeenCalledWith(h.buildGithubReport);
        expect(h.registerJellyfinReportBuilder).toHaveBeenCalledTimes(1);
        expect(h.startSilentStartSweeper).toHaveBeenCalledTimes(1);
        expect(h.registerJellyfinRemoteControl).toHaveBeenCalledTimes(1);
        // The loop's own idempotence handles the repeat call; the loader asks for it.
        expect(h.startRelayTokenEnrolLoop).toHaveBeenCalled();
    });

    it('starts the enrolment loop synchronously, before any registration finishes', async () => {
        const { ensureCompatLoaded } = await load();
        const pending = ensureCompatLoaded({ enrolRelayToken: true });
        expect(h.startRelayTokenEnrolLoop).toHaveBeenCalledTimes(1);
        await pending;
    });

    it('executor child, revocation fan-out and plugin ctx.ai: registrations only, no enrolment loop', async () => {
        const { ensureCompatLoaded } = await load();

        await ensureCompatLoaded();

        expect(h.registerAiAssistantProvider).toHaveBeenCalledTimes(1);
        expect(h.registerJellyfinCompatRevocationProvider).toHaveBeenCalledTimes(1);
        expect(h.startRelayTokenEnrolLoop).not.toHaveBeenCalled();
    });

    it('plugin-isolation worker: complete no-op, even when asked for the loop', async () => {
        h.worker = true;
        const { ensureCompatLoaded } = await load();

        await ensureCompatLoaded({ enrolRelayToken: true });

        expect(h.registerAiAssistantProvider).not.toHaveBeenCalled();
        expect(h.registerJellyfinCompatRevocationProvider).not.toHaveBeenCalled();
        expect(h.registerJellyfinResponseObserver).not.toHaveBeenCalled();
        expect(h.registerJellyfinReportBuilder).not.toHaveBeenCalled();
        expect(h.startSilentStartSweeper).not.toHaveBeenCalled();
        expect(h.registerJellyfinRemoteControl).not.toHaveBeenCalled();
        expect(h.startRelayTokenEnrolLoop).not.toHaveBeenCalled();
    });

    it('stream-proxy-only node: no enrolment loop and nothing that needs the database', async () => {
        h.streamProxyMode = true;
        const { ensureCompatLoaded } = await load();

        await ensureCompatLoaded({ enrolRelayToken: true });

        expect(h.startRelayTokenEnrolLoop).not.toHaveBeenCalled();
        expect(h.startSilentStartSweeper).not.toHaveBeenCalled();
        expect(h.registerJellyfinRemoteControl).not.toHaveBeenCalled();
        expect(h.registerAiAssistantProvider).not.toHaveBeenCalled();
        expect(h.registerJellyfinCompatRevocationProvider).not.toHaveBeenCalled();
        expect(h.registerJellyfinReportBuilder).not.toHaveBeenCalled();
        expect(h.registerJellyfinResponseObserver).toHaveBeenCalledTimes(1);
    });

    it('a broken registration is logged and never blocks the others, never rejects', async () => {
        h.registerJellyfinResponseObserver.mockImplementationOnce(() => {
            throw new Error('observer broke');
        });
        const { ensureCompatLoaded } = await load();

        await expect(ensureCompatLoaded()).resolves.toBeUndefined();

        expect(h.registerJellyfinReportBuilder).toHaveBeenCalledTimes(1);
        expect(h.startSilentStartSweeper).toHaveBeenCalledTimes(1);
        expect(h.registerJellyfinRemoteControl).toHaveBeenCalledTimes(1);
    });

    it('a failed registration is retried by the next call; steps that worked are not run again', async () => {
        h.registerJellyfinCompatRevocationProvider.mockImplementationOnce(() => {
            throw new Error('revocation broke');
        });
        const { ensureCompatLoaded, pendingCompatSteps } = await load();

        await ensureCompatLoaded();
        expect(pendingCompatSteps()).toEqual(['/j session revocation']);

        await ensureCompatLoaded();

        expect(h.registerJellyfinCompatRevocationProvider).toHaveBeenCalledTimes(2);
        expect(h.registerAiAssistantProvider).toHaveBeenCalledTimes(1);
        expect(h.registerJellyfinResponseObserver).toHaveBeenCalledTimes(1);
        expect(h.startSilentStartSweeper).toHaveBeenCalledTimes(1);
        expect(pendingCompatSteps()).toEqual([]);

        await ensureCompatLoaded();
        expect(h.registerJellyfinCompatRevocationProvider).toHaveBeenCalledTimes(2);
    });

    it('an enrolment loop that throws on start does not stop the registrations', async () => {
        h.startRelayTokenEnrolLoop.mockImplementationOnce(() => {
            throw new Error('boom');
        });
        const { ensureCompatLoaded } = await load();

        await ensureCompatLoaded({ enrolRelayToken: true });

        expect(h.registerAiAssistantProvider).toHaveBeenCalledTimes(1);
        expect(h.registerJellyfinCompatRevocationProvider).toHaveBeenCalledTimes(1);
    });
});

describe('every process entry point loads it', () => {
    // [file, what it must import]. The web server, the task runtime and its
    // executor children each boot their own process; the other two reach it lazily
    // (credential revocation fan-out, plugin ctx.ai surface).
    const entries: Array<[string, string]> = [
        ['src/hooks.server.ts', 'web'],
        ['src/task-runtime/index.ts', 'task runtime (worker)'],
        ['src/task-runtime/executor-child.ts', 'task executor child'],
        ['src/lib/server/services/credential-revocation.service.ts', 'revocation fan-out'],
        ['src/lib/server/tasks/plugin-ai-surface.ts', 'plugin ctx.ai surface'],
    ];

    it.each(entries)('%s (%s) calls ensureCompatLoaded from boot/compat-init', (file) => {
        const source = readFileSync(file, 'utf8');
        expect(source).toMatch(/boot\/compat-init\.js/);
        expect(source).toMatch(/ensureCompatLoaded\(/);
    });

    it('only the web server and the task runtime main process start the enrolment loop', () => {
        const asks = (file: string): boolean =>
            /ensureCompatLoaded\(\{\s*enrolRelayToken:\s*true\s*\}\)/.test(readFileSync(file, 'utf8'));
        expect(asks('src/hooks.server.ts')).toBe(true);
        expect(asks('src/task-runtime/index.ts')).toBe(true);
        for (const file of [
            'src/task-runtime/executor-child.ts',
            'src/lib/server/services/credential-revocation.service.ts',
            'src/lib/server/tasks/plugin-ai-surface.ts',
        ]) {
            expect(asks(file), file).toBe(false);
        }
    });

    it('both long-running processes stop the enrolment loop on shutdown', () => {
        for (const file of ['src/hooks.server.ts', 'src/task-runtime/index.ts']) {
            expect(readFileSync(file, 'utf8'), file).toMatch(/stopRelayTokenEnrolLoop\(\)/);
        }
    });

    it('nobody loads the registrations through the removed licence shim any more', () => {
        for (const [file] of entries) {
            const source = readFileSync(file, 'utf8');
            expect(/server\/licensing\//.test(source), file).toBe(false);
        }
    });
});
