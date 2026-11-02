// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, it } from 'vitest';
import { TaskOrchestrator } from './orchestrator.js';
import { TaskRegistry } from './registry.js';
import { stateMachine } from './state-machine.js';
import { computeIdentity, identityKey } from './identity.js';
import { requireClient } from './valkey-types.js';
import { connectValkey, disconnectValkey } from '$lib/server/cache/valkey.js';
import { mediaProbeTask } from './builtin/native/media-probe.js';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';

it('actual Media Probe enqueue deduplicates the same file while different files and broad inputs remain separate', async () => {
    const sql = getTestDb();
    await connectValkey();
    const registry = new TaskRegistry();
    registry.registerTask(mediaProbeTask);
    const orchestrator = await TaskOrchestrator.start(['io'], {
        registry,
        stateMachine,
        getSql: () => sql,
        getClient: requireClient,
    });
    const owned = new Set<string>();
    const identityKeys = new Set<string>();
    try {
        const fileId = crypto.randomUUID();
        const otherId = crypto.randomUUID();
        const inputs = [
            { fileId },
            { fileId: fileId.toUpperCase() },
            { fileId: otherId },
            {},
            { mode: 'manual' },
        ];
        for (const input of inputs)
            identityKeys.add(identityKey('media-probe', computeIdentity(mediaProbeTask, input)));
        const results = await Promise.all(
            inputs.map((input) => orchestrator.startRun('media-probe', input)),
        );
        for (const result of results) owned.add(result.runId);
        expect(results[0].runId).toBe(results[1].runId);
        expect(results.slice(0, 2).filter((result) => result.deduped)).toHaveLength(1);
        expect(owned.size).toBe(4);
        expect((await orchestrator.getRun(results[0].runId))?.input).toEqual({ fileId });
        expect((await orchestrator.getRun(results[2].runId))?.input).toEqual({ fileId: otherId });
        expect((await orchestrator.getRun(results[3].runId))?.input).toEqual({});
        const [count] =
            await sql`SELECT count(*)::int AS n FROM task_history WHERE id = ANY(${sql.array([...owned])}::text[])`;
        expect(count.n).toBe(4);
    } finally {
        for (const id of owned) await orchestrator.cancelRun(id);
        await orchestrator.stop();
        if (identityKeys.size > 0) await requireClient().customCommand(['DEL', ...identityKeys]);
        for (const id of owned) await sql`DELETE FROM task_history WHERE id = ${id}`;
        await disconnectValkey();
        await closeTestDb();
    }
}, 30000);
