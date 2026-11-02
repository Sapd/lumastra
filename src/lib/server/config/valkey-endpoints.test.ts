// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
    assertValkeyEndpointConfiguration,
    ValkeyEndpointConfigurationError,
    VALKEY_UPGRADE_DOCS_URL,
} from './valkey-endpoints';

const task = 'redis://tasks:6379/1';

describe('Valkey endpoint topology', () => {
    it('requires an explicit task endpoint without using cache as fallback', () => {
        expect(() => assertValkeyEndpointConfiguration({ CACHE_URL: 'redis://cache' })).toThrow(
            'TASK_CACHE_URL is required',
        );
        expect(() => assertValkeyEndpointConfiguration({})).toThrow(
            ValkeyEndpointConfigurationError,
        );
    });

    it('tells an upgrading install exactly what to add and where the guide is', () => {
        for (const env of [{ CACHE_URL: 'redis://cache' }, {}]) {
            try {
                assertValkeyEndpointConfiguration(env);
                expect.unreachable();
            } catch (error) {
                const message = String(error);
                expect(message).toContain('TASK_CACHE_URL is required');
                expect(message).toContain('second Valkey service');
                expect(message).toContain('existing Valkey');
                expect(message).toContain('--maxmemory-policy noeviction --appendonly yes');
                expect(message).toContain(VALKEY_UPGRADE_DOCS_URL);
            }
        }
        expect(VALKEY_UPGRADE_DOCS_URL).toBe(
            'https://lumastra.org/guides/deploy-docker/#upgrading-to-the-dedicated-worker-and-two-valkeys',
        );
        expect(() =>
            assertValkeyEndpointConfiguration({
                TASK_CACHE_URL: 'redis://a',
                CACHE_URL: 'redis://a',
            }),
        ).toThrow(VALKEY_UPGRADE_DOCS_URL);
    });

    it('permits memory caching while preserving the required task endpoint', () => {
        expect(assertValkeyEndpointConfiguration({ TASK_CACHE_URL: task }).cache).toBeNull();
    });

    it.each([
        ['redis://CACHE', 'redis://cache:6379/0'],
        ['redis://cache./1', 'redis://cache/2'],
        ['redis://cache%2e/1', 'redis://cache/2'],
        ['redis://one:secret@cache/1', 'rediss://two:other@CACHE:6379/15'],
        ['redis://127.000.000.001/1', 'redis://127.0.0.1/0'],
        ['redis://[::ffff:127.0.0.1]/1', 'redis://127.0.0.1/0'],
        ['redis://[::ffff:7f00:1]/1', 'redis://127.0.0.1/0'],
        ['redis://[0:0:0:0:0:0:0:1]/1', 'redis://[::1]/0'],
    ])('rejects equivalent instance spellings %s and %s', (taskUrl, cacheUrl) => {
        expect(() =>
            assertValkeyEndpointConfiguration({ TASK_CACHE_URL: taskUrl, CACHE_URL: cacheUrl }),
        ).toThrow('distinct Valkey instances');
    });

    it('allows distinct ports on the same host', () => {
        const result = assertValkeyEndpointConfiguration({
            TASK_CACHE_URL: 'redis://localhost:6380',
            CACHE_URL: 'redis://localhost:6379',
        });
        expect(result.task.port).toBe(6380);
        expect(result.task.database).toBe(0);
        expect(result.cache?.database).toBe(0);
    });

    it('does not claim to resolve DNS aliases', () => {
        expect(
            assertValkeyEndpointConfiguration({
                TASK_CACHE_URL: 'redis://task-name',
                CACHE_URL: 'redis://another-name',
            }).cache?.host,
        ).toBe('another-name');
    });

    it('preserves TLS, database and decoded credentials for clients', () => {
        expect(
            assertValkeyEndpointConfiguration({
                TASK_CACHE_URL: 'rediss://user%40name:p%40ss@TASKS/7',
            }).task,
        ).toEqual({
            host: 'tasks',
            port: 6379,
            database: 7,
            username: 'user@name',
            password: 'p@ss',
            tls: true,
        });
    });

    it.each([
        '',
        'not-a-url',
        'http://tasks',
        'redis://',
        'redis://tasks:0',
        'redis://tasks:65536',
        'redis://tasks/-1',
        'redis://tasks/1x',
        'redis://tasks/1/2',
        'redis://tasks/9007199254740992',
        'redis://tasks/2147483648',
        'redis://tasks/4294967296',
        'redis://tasks/4294967297',
        'redis://tasks/0?db=1',
        'redis://tasks/#fragment',
        ' redis://tasks',
        'redis://ta\nsks',
    ])('rejects invalid task endpoint %j', (url) => {
        expect(() => assertValkeyEndpointConfiguration({ TASK_CACHE_URL: url })).toThrow(
            ValkeyEndpointConfigurationError,
        );
    });

    it.each(['CACHE_URL', 'TASK_CACHE_URL'] as const)(
        'never exposes credentials in malformed %s diagnostics',
        (variable) => {
            const bad = 'redis://secret-user:secret-password@[invalid';
            try {
                assertValkeyEndpointConfiguration({ TASK_CACHE_URL: task, [variable]: bad });
                expect.unreachable();
            } catch (error) {
                expect(error).toBeInstanceOf(ValkeyEndpointConfigurationError);
                expect(String(error)).toContain(variable);
                expect(String(error)).not.toContain('secret-');
                expect(error).not.toHaveProperty('cause');
                expect(error).not.toHaveProperty('input');
            }
        },
    );

    it('explains an unencoded special character in the password', () => {
        expect(() =>
            assertValkeyEndpointConfiguration({
                TASK_CACHE_URL: 'redis://default:pa#ss@tasks:6379/0',
            }),
        ).toThrow(/percent-encode those characters/);
    });

    it('defaults TASK_CACHE_URL without a /db path to database 0 (single-Valkey installs)', () => {
        expect(
            assertValkeyEndpointConfiguration({ TASK_CACHE_URL: 'redis://tasks:6379' }).task
                .database,
        ).toBe(0);
    });
});
