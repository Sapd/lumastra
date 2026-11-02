// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { assertOwnedSchema, validatePilotEnvironment, withTimeout } from '../harness.mjs';

// This child never creates, migrates or drops a schema. The parent owns teardown.
// Validate the environment before loading either database dependency.
const target = validatePilotEnvironment();
assert.equal(typeof process.send, 'function', 'Process fixture requires parent IPC');
const require = createRequire(import.meta.url);
const ownModules = realpathSync(fileURLToPath(new URL('../node_modules/', import.meta.url)));
for (const [name, version] of [
    ['bullmq', '6.3.15'],
    ['pg', '8.23.1'],
]) {
    const manifest = require.resolve(`${name}/package.json`);
    assert.ok(realpathSync(manifest).startsWith(`${ownModules}/`), 'Use isolated dependencies');
    assert.equal(require(manifest).version, version);
}
const { Worker, createPostgresBackend } = require('bullmq');
const { Pool } = require('pg');

function fail() {
    // Never serialize driver errors: they may contain connection credentials.
    process.send?.({ type: 'fixture-error' });
    process.exit(1);
}
const startupDeadline = setTimeout(fail, 15000);
process.once('disconnect', () => process.exit(1));
process.once('message', async (config) => {
    let guard;
    try {
        assertOwnedSchema(config.owned, config.owned);
        assert.equal(config.queueName.startsWith(`${config.owned.nonce}_`), true);
        const connection = {
            connectionString: target.databaseUrl,
            schema: config.owned.schema,
            migrate: false,
            max: 2,
            application_name: `${config.owned.schema}_child`,
            connectionTimeoutMillis: 5000,
            idleTimeoutMillis: 1000,
            statement_timeout: 10000,
            query_timeout: 12000,
        };
        guard = new Pool(connection);
        guard.on('error', fail);
        const identity = await guard.query(
            `
            SELECT n.nspname AS schema, n.oid::text AS oid,
                   pg_get_userbyid(n.nspowner) AS owner,
                   obj_description(n.oid, 'pg_namespace') AS marker
            FROM pg_namespace n WHERE n.nspname = $1`,
            [config.owned.schema],
        );
        assertOwnedSchema(config.owned, identity.rows[0]);
        await withTimeout(guard.end(), 5000, 'child schema guard closure');
        guard = undefined;
        const worker = new Worker(
            config.queueName,
            async (job, token) => {
                clearTimeout(startupDeadline);
                process.send({
                    type: 'claimed',
                    id: job.id,
                    token,
                    pid: process.pid,
                    attemptsStarted: job.attemptsStarted,
                });
                // The real processor remains active with ordinary automatic renewals
                // until the parent observes its claim and kills this exact process.
                return new Promise(() => {});
            },
            { connection, lockDuration: 1000, stalledInterval: 100, drainDelay: 0.1 },
            createPostgresBackend,
        );
        worker.on('error', fail);
        await withTimeout(worker.waitUntilReady(), 10000, 'child worker readiness');
    } catch {
        if (guard)
            await withTimeout(guard.end(), 5000, 'child guard failure cleanup').catch(() => {});
        fail();
    }
});
