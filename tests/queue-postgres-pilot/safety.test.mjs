// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import test from 'node:test';
import { assertOwnedSchema, createHarness, validatePilotEnvironment } from './harness.mjs';

const safeUrl = 'postgresql://pilot:secret@127.0.0.1:5434/lumastra_t_pilot';
const optedIn = { BULLMQ_PG_PILOT: '1', TEST_DATABASE_URL: safeUrl };

test('safety: requires affirmative opt-in and an explicit test URL', async () => {
    for (const env of [
        {},
        { TEST_DATABASE_URL: safeUrl },
        { ...optedIn, BULLMQ_PG_PILOT: 'true' },
        { BULLMQ_PG_PILOT: '1', DATABASE_URL: safeUrl },
        { ...optedIn, PILOT_DATABASE_URL: '' },
    ]) {
        assert.throws(() => validatePilotEnvironment(env), /pilot/i);
        // Validation runs before dependency loading or driver construction. This
        // test also runs successfully without any node_modules or live database.
        await assert.rejects(createHarness({ env }), /pilot/i);
    }
});

test('safety: rejects malformed URLs, production DB names and public endpoints', async () => {
    for (const url of [
        'not-a-url',
        'https://pilot:secret@127.0.0.1:5434/lumastra_tests',
        'postgresql://pilot:secret@127.0.0.1:5434/lumastra',
        'postgresql://pilot:secret@127.0.0.1:5434/lumastra_dev',
        'postgresql://pilot:secret@127.0.0.1:5434/lumastra_tests_backup',
        'postgresql://pilot:secret@203.0.113.10:5434/lumastra_tests',
        'postgresql://pilot:secret@10.0.0.10:5434/lumastra_tests',
        'postgresql://pilot:secret@db.example.test:5434/lumastra_tests',
        'postgresql://pilot:secret@127.0.0.1:5433/lumastra_tests',
        'postgresql://pilot:secret@127.0.0.1:5434/lumastra_tests#override',
        'postgresql://127.0.0.1:5434/lumastra_tests',
    ]) {
        const env = { BULLMQ_PG_PILOT: '1', TEST_DATABASE_URL: url };
        assert.throws(() => validatePilotEnvironment(env), /pilot/i);
        await assert.rejects(createHarness({ env }), /pilot/i);
    }
});

test('safety: URL query overrides cannot bypass endpoint or schema validation', () => {
    for (const query of [
        'host=production.internal',
        'database=lumastra',
        'dbname=lumastra',
        'port=5433',
        'options=-c%20search_path=public',
        'application_name=other',
        'user=postgres',
    ]) {
        assert.throws(
            () =>
                validatePilotEnvironment({
                    ...optedIn,
                    TEST_DATABASE_URL: `${safeUrl}?${query}`,
                }),
            /connection overrides/,
        );
    }
});

test('safety: accepts only the sanctioned runner database vocabulary', () => {
    for (const url of [
        safeUrl,
        'postgresql://pilot@localhost:5432/lumastra_tests',
        'postgresql://pilot@[::1]:5434/lumastra_t_slot_42?sslmode=disable',
    ]) {
        const validated = validatePilotEnvironment({ ...optedIn, TEST_DATABASE_URL: url });
        assert.match(validated.database, /^(?:lumastra_tests|lumastra_t_[a-z0-9_]+)$/);
        assert.ok(Object.isFrozen(validated));
    }
    const override = 'postgresql://pilot@localhost:5432/lumastra_t_explicit';
    assert.equal(
        validatePilotEnvironment({ ...optedIn, PILOT_DATABASE_URL: override }).database,
        'lumastra_t_explicit',
    );
});

test('safety: validation errors never print credentials or the full URL', () => {
    for (const url of [
        'postgresql://pilot:never-print-this@203.0.113.10/lumastra_tests',
        'postgresql://pilot:never-print-this@127.0.0.1/lumastra',
    ]) {
        assert.throws(
            () => validatePilotEnvironment({ ...optedIn, TEST_DATABASE_URL: url }),
            (error) => !error.message.includes('never-print-this') && !error.message.includes(url),
        );
    }
});

test('safety: cleanup refuses any name, OID, marker or owner drift', () => {
    const nonce = 'a'.repeat(32);
    const expected = {
        schema: `pilot_bmq_${nonce}`,
        nonce,
        oid: '123',
        marker: `bullmq-pilot:${nonce}`,
        owner: 'pilot',
    };
    assert.doesNotThrow(() => assertOwnedSchema(expected, { ...expected }));
    for (const actual of [
        undefined,
        { ...expected, schema: 'public' },
        { ...expected, schema: 'bullmq' },
        { ...expected, oid: '124' },
        { ...expected, marker: null },
        { ...expected, owner: 'someone_else' },
    ]) {
        assert.throws(() => assertOwnedSchema(expected, actual), /Refusing cleanup/);
    }
    for (const invalid of [
        { ...expected, schema: 'public' },
        { ...expected, nonce: 'b'.repeat(32) },
        { ...expected, oid: '0' },
        { ...expected, marker: 'borrowed-schema' },
    ]) {
        assert.throws(() => assertOwnedSchema(invalid, invalid), /Refusing cleanup/);
    }
});
