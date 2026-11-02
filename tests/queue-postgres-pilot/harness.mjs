// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ownModules = fileURLToPath(new URL('./node_modules/', import.meta.url));
const schemaPattern = /^pilot_bmq_[a-f0-9]{32}$/;

/** Validate before importing a driver, constructing a pool, or opening a socket. */
export function validatePilotEnvironment(env = process.env) {
    if (env.BULLMQ_PG_PILOT !== '1') {
        throw new Error('PostgreSQL pilot requires BULLMQ_PG_PILOT=1');
    }
    // Deliberately never consult DATABASE_URL, PGHOST, or application configuration.
    const databaseUrl = env.PILOT_DATABASE_URL ?? env.TEST_DATABASE_URL;
    if (typeof databaseUrl !== 'string' || databaseUrl.trim() === '') {
        throw new Error('PostgreSQL pilot requires PILOT_DATABASE_URL or TEST_DATABASE_URL');
    }
    let url;
    try {
        url = new URL(databaseUrl);
    } catch {
        throw new Error('PostgreSQL pilot database URL is invalid');
    }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hash || !url.username) {
        throw new Error('PostgreSQL pilot requires an explicit PostgreSQL test endpoint');
    }
    let database;
    try {
        database = decodeURIComponent(url.pathname.slice(1));
    } catch {
        throw new Error('PostgreSQL pilot database name is invalid');
    }
    if (!/^(?:lumastra_tests|lumastra_t_[a-z0-9_]+)$/.test(database)) {
        throw new Error('PostgreSQL pilot refuses databases outside the sanctioned test runner');
    }
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
        throw new Error('PostgreSQL pilot requires a loopback test-runner address');
    }
    const port = Number(url.port || 5432);
    if (![5432, 5434].includes(port)) {
        throw new Error('PostgreSQL pilot requires the sanctioned test-runner port');
    }
    // node-postgres URL query parameters can override host/database/options. Permit
    // only TLS mode; in particular a second host or search_path must never bypass
    // the endpoint/schema checks above.
    for (const key of url.searchParams.keys()) {
        if (key !== 'sslmode') {
            throw new Error('PostgreSQL pilot refuses database URL connection overrides');
        }
    }
    return Object.freeze({ databaseUrl, database, host, port });
}

/** Pure cleanup guard, independently testable without loading PostgreSQL. */
export function assertOwnedSchema(expected, actual) {
    if (
        !expected ||
        !schemaPattern.test(expected.schema) ||
        expected.marker !== `bullmq-pilot:${expected.nonce}` ||
        expected.schema !== `pilot_bmq_${expected.nonce}` ||
        !Number.isSafeInteger(Number(expected.oid)) ||
        Number(expected.oid) <= 0 ||
        typeof expected.owner !== 'string' ||
        expected.owner.length === 0 ||
        !actual ||
        actual.schema !== expected.schema ||
        String(actual.oid) !== String(expected.oid) ||
        actual.marker !== expected.marker ||
        actual.owner !== expected.owner
    ) {
        throw new Error('Refusing cleanup: PostgreSQL schema is not the exact run-owned schema');
    }
}

export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

export async function withTimeout(promise, ms = 15000, label = 'pilot operation') {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

export async function waitFor(
    predicate,
    { timeoutMs = 15000, intervalMs = 25, message = 'pilot condition' } = {},
) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const result = await withTimeout(
            Promise.resolve().then(predicate),
            Math.max(1, deadline - Date.now()),
            message,
        );
        if (result) return result;
        await sleep(intervalMs);
    }
    throw new Error(`${message} timed out after ${timeoutMs}ms`);
}

function loadDependencies() {
    for (const [name, version] of [
        ['bullmq', '6.3.15'],
        ['pg', '8.23.1'],
    ]) {
        let manifest;
        try {
            manifest = require.resolve(`${name}/package.json`);
        } catch {
            throw new Error(`Install the isolated pilot dependencies first: missing ${name}`);
        }
        // A stale ancestor node_modules must never silently qualify another version.
        if (
            !realpathSync(manifest).startsWith(`${realpathSync(ownModules)}/`) ||
            require(manifest).version !== version
        ) {
            throw new Error(`PostgreSQL pilot requires its own ${name}@${version} installation`);
        }
    }
    return { classes: require('bullmq'), pg: require('pg') };
}

const schemaIdentityQuery = `
  SELECT n.nspname AS schema, n.oid::text AS oid,
         pg_get_userbyid(n.nspowner) AS owner,
         obj_description(n.oid, 'pg_namespace') AS marker
    FROM pg_namespace n WHERE n.nspname = $1`;

export async function createHarness({ env = process.env, label = 'core' } = {}) {
    const target = validatePilotEnvironment(env);
    const { classes, pg } = loadDependencies();
    const nonce = randomUUID().replaceAll('-', '');
    const schema = `pilot_bmq_${nonce}`;
    const applicationName = schema;
    const marker = `bullmq-pilot:${nonce}`;
    const quotedSchema = `"${schema}"`; // Only randomUUID hex can reach this identifier.
    const admin = new pg.Pool({
        connectionString: target.databaseUrl,
        max: 2,
        application_name: applicationName,
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 1000,
        statement_timeout: 10000,
        query_timeout: 12000,
    });
    const observedErrors = [];
    admin.on('error', (error) => {
        observedErrors.push(error);
    });
    const resources = [];
    let owned;
    let closing;
    const connection = Object.freeze({
        connectionString: target.databaseUrl,
        schema,
        migrate: false,
        max: 2,
        application_name: applicationName,
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 1000,
        statement_timeout: 10000,
        query_timeout: 12000,
        keepAlive: true,
        keepAliveInitialDelayMillis: 1000,
    });
    function name(logicalName) {
        if (typeof logicalName !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(logicalName)) {
            throw new Error('Pilot queue names must be simple identifiers');
        }
        return logicalName.startsWith(`${nonce}_`) ? logicalName : `${nonce}_${logicalName}`;
    }
    function track(resource, kind) {
        resource.on('error', (error) => {
            observedErrors.push(error);
        });
        resources.push({ resource, kind });
        return resource;
    }
    function options(value) {
        if ('connection' in value || 'prefix' in value) {
            throw new Error('Pilot resource options cannot override the run-owned connection');
        }
        return { ...value, connection };
    }
    async function close() {
        if (closing) return closing;
        closing = (async () => {
            const failures = [];
            const errorsBeforeClose = observedErrors.length;
            for (const kind of ['worker', 'events', 'flow', 'queue']) {
                for (const { resource } of resources
                    .filter((entry) => entry.kind === kind)
                    .reverse()) {
                    try {
                        await withTimeout(resource.close(), 12000, `close pilot ${kind}`);
                    } catch (error) {
                        failures.push(error);
                        // Interrupt database waits even if a processor failed to settle. The
                        // timeout remains a failure; it is never converted into a pass.
                        try {
                            if (typeof resource.disconnect === 'function') {
                                await withTimeout(
                                    resource.disconnect(),
                                    5000,
                                    `disconnect pilot ${kind}`,
                                );
                            }
                        } catch (disconnectError) {
                            failures.push(disconnectError);
                        }
                    }
                }
            }
            try {
                if (owned) {
                    const actual = (await admin.query(schemaIdentityQuery, [schema])).rows[0];
                    assertOwnedSchema(owned, actual);
                    await admin.query(`DROP SCHEMA ${quotedSchema} CASCADE`);
                }
            } catch (error) {
                failures.push(error);
            }
            try {
                await withTimeout(admin.end(), 5000, 'close pilot administration pool');
            } catch (error) {
                failures.push(error);
            }
            // Worker.close() can emit a cleanup error and resolve. Treat those events
            // as teardown failures too; a resolved promise alone does not prove closure.
            failures.push(...observedErrors.slice(errorsBeforeClose));
            if (failures.length)
                throw new AggregateError(failures, 'PostgreSQL pilot cleanup failed');
        })();
        return closing;
    }
    try {
        const client = await admin.connect();
        let clientReleased = false;
        try {
            await client.query('BEGIN');
            // Never adopt an existing schema, even one with an identical-looking name.
            await client.query(`CREATE SCHEMA ${quotedSchema}`);
            await client.query(`COMMENT ON SCHEMA ${quotedSchema} IS '${marker}'`);
            const identity = (await client.query(schemaIdentityQuery, [schema])).rows[0];
            await client.query('COMMIT');
            owned = Object.freeze({ ...identity, nonce });
            assertOwnedSchema(owned, identity);
            await withTimeout(
                classes.runMigrations(client, schema),
                30000,
                'pilot schema migrations',
            );
            // Verify migration placement through the catalog rather than assuming the
            // configured schema was honored. No application/private queue tables used.
            const ledger = await client.query('SELECT to_regclass($1)::text AS ledger', [
                `${schema}.migration`,
            ]);
            if (!ledger.rows[0]?.ledger)
                throw new Error('Pilot migration ledger missing from owned schema');
        } catch (error) {
            // Promise.race does not cancel runMigrations. A timeout may leave
            // its query in flight: destroy that physical session rather than
            // issuing ROLLBACK concurrently or returning it to the pool. The
            // server rolls its transaction back when the connection ends;
            // schema cleanup below uses another administration connection.
            let destructionFailure;
            try {
                client.release(true);
            } catch (destructionError) {
                destructionFailure = destructionError;
            }
            clientReleased = true;
            if (destructionFailure) {
                throw new AggregateError(
                    [error, destructionFailure],
                    'Pilot initialization and session destruction failed',
                    { cause: error },
                );
            }
            throw error;
        } finally {
            if (!clientReleased) client.release();
        }
        return Object.freeze({
            schema,
            nonce,
            applicationName,
            connection,
            classes,
            label,
            name,
            observedErrors,
            queue: (queueName, opts = {}) =>
                track(
                    new classes.Queue(
                        name(queueName),
                        options(opts),
                        classes.createPostgresBackend,
                    ),
                    'queue',
                ),
            worker: (queueName, processor, opts = {}) =>
                track(
                    new classes.Worker(
                        name(queueName),
                        processor,
                        options({ drainDelay: 0.1, ...opts }),
                        classes.createPostgresBackend,
                    ),
                    'worker',
                ),
            events: (queueName, opts = {}) =>
                track(
                    new classes.QueueEvents(
                        name(queueName),
                        options(opts),
                        classes.createPostgresBackend,
                    ),
                    'events',
                ),
            flow: (opts = {}) =>
                track(
                    new classes.FlowProducer(options(opts), classes.createPostgresBackend),
                    'flow',
                ),
            query: (text, params = []) => admin.query(text, params),
            assertHealthy: () => {
                if (observedErrors.length) {
                    throw new AggregateError(
                        [...observedErrors],
                        'PostgreSQL pilot emitted backend errors',
                    );
                }
            },
            close,
        });
    } catch (error) {
        let cleanupFailure;
        try {
            await close();
        } catch (cleanupError) {
            cleanupFailure = cleanupError;
        }
        if (cleanupFailure) {
            throw new AggregateError(
                [error, cleanupFailure],
                'Pilot initialization and cleanup failed',
                { cause: error },
            );
        }
        throw error;
    }
}
