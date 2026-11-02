// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import test from 'node:test';
import { assertOwnedSchema, createHarness } from './harness.mjs';

const identityQuery = `
    SELECT n.nspname AS schema, n.oid::text AS oid,
           pg_get_userbyid(n.nspowner) AS owner,
           obj_description(n.oid, 'pg_namespace') AS marker
      FROM pg_namespace n WHERE n.nspname = $1`;

function quotedSchema(harness) {
    assert.match(harness.schema, /^pilot_bmq_[a-f0-9]{32}$/);
    return `"${harness.schema}"`;
}

async function createSentinel(harness) {
    const namespace = quotedSchema(harness);
    await harness.query(`CREATE TABLE ${namespace}.pilot_sentinel (
        id text PRIMARY KEY, value text NOT NULL)`);
    await harness.query(`INSERT INTO ${namespace}.pilot_sentinel (id, value) VALUES ($1, $2)`, [
        harness.nonce,
        'preserve this independent namespace',
    ]);
}

async function assertSentinel(harness) {
    const result = await harness.query(
        `SELECT id, value FROM ${quotedSchema(harness)}.pilot_sentinel`,
    );
    assert.deepEqual(result.rows, [
        {
            id: harness.nonce,
            value: 'preserve this independent namespace',
        },
    ]);
}

async function closeAll(harnesses) {
    const errors = [];
    for (const harness of harnesses) {
        if (!harness) continue;
        try {
            await harness.close();
        } catch (error) {
            errors.push(error);
        }
    }
    if (errors.length) throw new AggregateError(errors, 'Isolation fixture cleanup failed');
}

test(
    'isolation: normal cleanup preserves a sentinel in another run-owned namespace',
    {
        timeout: 90000,
    },
    async () => {
        const witness = await createHarness({ label: 'isolation-witness' });
        let subject;
        try {
            await createSentinel(witness);
            subject = await createHarness({ label: 'isolation-subject' });
            assert.notEqual(subject.schema, witness.schema);
            await subject.close();
            const removed = await witness.query('SELECT to_regnamespace($1)::text AS namespace', [
                subject.schema,
            ]);
            assert.equal(removed.rows[0].namespace, null);
            await assertSentinel(witness);
            witness.assertHealthy();
            subject.assertHealthy();
        } finally {
            await closeAll([subject, witness]);
        }
    },
);

test(
    'isolation: actual marker drift refuses cleanup and leaves an independent sentinel intact',
    {
        timeout: 90000,
    },
    async () => {
        const witness = await createHarness({ label: 'drift-witness' });
        let subject;
        let expected;
        let markerChanged = false;
        const alteredMarker = 'pilot marker drift probe';
        const cleanupErrors = [];
        try {
            await createSentinel(witness);
            subject = await createHarness({ label: 'drift-subject' });
            const identity = (await witness.query(identityQuery, [subject.schema])).rows[0];
            expected = Object.freeze({ ...identity, nonce: subject.nonce });
            assertOwnedSchema(expected, identity);
            await witness.query(`COMMENT ON SCHEMA ${quotedSchema(subject)} IS '${alteredMarker}'`);
            markerChanged = true;
            await assert.rejects(subject.close(), (error) => {
                assert.ok(error instanceof AggregateError);
                assert.ok(error.errors.some((entry) => /Refusing cleanup/.test(entry.message)));
                return true;
            });
            const retained = (await witness.query(identityQuery, [subject.schema])).rows[0];
            assert.equal(retained.oid, expected.oid);
            assert.equal(retained.marker, alteredMarker);
            await assertSentinel(witness);
            witness.assertHealthy();
            subject.assertHealthy();
        } catch (error) {
            cleanupErrors.push(error);
        } finally {
            if (markerChanged) {
                try {
                    // subject.close() ended its administration pool. Recover only
                    // through the independent witness connection, checking the
                    // original immutable identity before restoring its marker.
                    // This controlled test slot assumes no concurrent hostile DDL.
                    const actual = (await witness.query(identityQuery, [subject.schema])).rows[0];
                    if (actual) {
                        assert.ok([alteredMarker, expected.marker].includes(actual.marker));
                        assertOwnedSchema(expected, { ...actual, marker: expected.marker });
                        await witness.query(
                            `COMMENT ON SCHEMA ${quotedSchema(subject)} IS '${expected.marker}'`,
                        );
                        const restored = (await witness.query(identityQuery, [subject.schema]))
                            .rows[0];
                        assertOwnedSchema(expected, restored);
                        await witness.query(`DROP SCHEMA ${quotedSchema(subject)} CASCADE`);
                        await assertSentinel(witness);
                    }
                } catch (error) {
                    cleanupErrors.push(error);
                }
            } else if (subject) {
                try {
                    await subject.close();
                } catch (error) {
                    cleanupErrors.push(error);
                }
            }
            try {
                await witness.close();
            } catch (error) {
                cleanupErrors.push(error);
            }
        }
        if (cleanupErrors.length) {
            throw new AggregateError(cleanupErrors, 'Marker-drift fixture failed');
        }
    },
);
