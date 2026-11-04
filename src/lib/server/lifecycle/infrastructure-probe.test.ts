// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import net from 'node:net';
import { describe, expect, it } from 'vitest';
import {
    createInfrastructureProbe,
    missingProbeTargets,
    probeTargetsFromEnvironment,
    type ProbeAttempt,
    type ProbeTarget,
} from './infrastructure-probe.js';

const target: ProbeTarget = { name: 'task-valkey', host: 'valkey', port: 6379 };
const scripted = (...attempts: ProbeAttempt[]) => {
    let i = 0;
    return async (): Promise<ProbeAttempt> => attempts[Math.min(i++, attempts.length - 1)];
};

describe('createInfrastructureProbe', () => {
    it('says up when the server accepts the connection', async () => {
        const probe = createInfrastructureProbe({
            targets: [target],
            connect: scripted({ ok: true }),
        });
        expect((await probe.verdict()).state).toBe('up');
    });

    it.each(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH'])(
        'says gone at once on %s',
        async (code) => {
            const probe = createInfrastructureProbe({
                targets: [target],
                connect: scripted({ ok: false, code }),
            });
            expect(await probe.verdict()).toMatchObject({ state: 'gone', evidence: 'error' });
        },
    );

    it('never calls a single unanswered connect gone: a blocked event loop looks like that', async () => {
        const probe = createInfrastructureProbe({
            targets: [target],
            connect: scripted({ timeout: true }, { ok: true }, { timeout: true }),
        });
        expect((await probe.verdict()).state).toBe('unknown');
        expect((await probe.verdict()).state).toBe('up');
        // The silent streak starts over after an answer.
        expect((await probe.verdict()).state).toBe('unknown');
    });

    it('needs a reset twice: a proxy under load resets too', async () => {
        const probe = createInfrastructureProbe({
            targets: [target],
            connect: scripted({ ok: false, code: 'ECONNRESET' }, { ok: false, code: 'ECONNRESET' }),
        });
        expect((await probe.verdict()).state).toBe('unknown');
        expect(await probe.verdict()).toMatchObject({ state: 'gone', evidence: 'silence' });
    });

    it('judges only the servers it is asked about', async () => {
        const probe = createInfrastructureProbe({
            targets: [
                { name: 'postgres', host: 'pg', port: 5432 },
                { name: 'task-valkey', host: 'valkey', port: 6379 },
            ],
            connect: async (t) =>
                t.name === 'task-valkey' ? { ok: false, code: 'ECONNREFUSED' } : { ok: true },
        });
        expect((await probe.verdict(['postgres'])).state).toBe('up');
        expect(await probe.verdict(['task-valkey'])).toMatchObject({
            state: 'gone',
            target: 'task-valkey',
        });
        expect(await probe.verdict()).toMatchObject({ state: 'gone', target: 'task-valkey' });
    });

    it('calls the server gone after two silent connects in a row', async () => {
        const probe = createInfrastructureProbe({
            targets: [target],
            connect: scripted({ timeout: true }),
        });
        expect((await probe.verdict()).state).toBe('unknown');
        expect(await probe.verdict()).toMatchObject({ state: 'gone', evidence: 'silence' });
    });

    it('ignores errors that say nothing about the host', async () => {
        const probe = createInfrastructureProbe({
            targets: [target],
            connect: scripted({ ok: false, code: 'EACCES' }),
        });
        expect((await probe.verdict()).state).toBe('up');
    });

    it('reports a refused port on a real socket', async () => {
        const server = net.createServer();
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = (server.address() as net.AddressInfo).port;
        const probe = createInfrastructureProbe({
            targets: [{ name: 'postgres', host: '127.0.0.1', port }],
        });
        expect((await probe.verdict()).state).toBe('up');
        await new Promise<void>((resolve) => server.close(() => resolve()));
        expect(await probe.verdict()).toMatchObject({ state: 'gone', evidence: 'error' });
    });
});

describe('probeTargetsFromEnvironment', () => {
    it('reads the database and Valkey endpoints, with default ports', () => {
        const env = {
            DATABASE_URL: 'postgresql://u:p@lumastra-postgres/lumastra',
            TASK_CACHE_URL: 'redis://default:pw@lumastra-valkey:6380/0',
            CACHE_URL: 'redis://default:pw@lumastra-valkey-cache:6379/0',
        };
        expect(probeTargetsFromEnvironment(env, { cache: false })).toEqual([
            { name: 'postgres', host: 'lumastra-postgres', port: 5432 },
            { name: 'task-valkey', host: 'lumastra-valkey', port: 6380 },
        ]);
        expect(probeTargetsFromEnvironment(env, { cache: true })).toHaveLength(3);
    });

    it('skips what is missing or unparsable', () => {
        expect(probeTargetsFromEnvironment({ DATABASE_URL: 'not a url' }, { cache: true })).toEqual(
            [],
        );
    });
});

describe('missingProbeTargets', () => {
    it('names the servers no target could be derived for', () => {
        const targets = probeTargetsFromEnvironment(
            { DATABASE_URL: 'postgresql://u@/lumastra?host=/var/run/postgresql' },
            { cache: false },
        );
        expect(missingProbeTargets(targets, ['postgres', 'task-valkey'])).toEqual([
            'postgres',
            'task-valkey',
        ]);
    });
});
