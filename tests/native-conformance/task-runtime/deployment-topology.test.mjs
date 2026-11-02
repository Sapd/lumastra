// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseDocument } from 'yaml';

const project = new URL('../../../', import.meta.url);
async function load(relative) {
    const document = parseDocument(await readFile(new URL(relative, project), 'utf8'));
    assert.deepEqual(document.errors, [], relative);
    return document.toJS();
}

test('default production Compose always includes web, one lean worker and two isolated Valkeys', async () => {
    const config = await load('docker-compose.example.yml');
    const web = config.services.lumastra;
    const worker = config.services['lumastra-worker'];
    assert.equal(web.environment.WORKER_MODE, 'disabled');
    assert.equal(web.environment.DEDICATED_WORKER, 'false');
    assert.equal(worker.profiles, undefined);
    assert.deepEqual(worker.command, ['./start-worker.sh']);
    assert.equal(worker.environment.WORKER_MODE, 'enabled');
    assert.equal(worker.environment.DEDICATED_WORKER, 'true');
    for (const key of ['DATABASE_URL', 'CACHE_URL', 'TASK_CACHE_URL', 'BASE_PATH']) {
        assert.equal(worker.environment[key], web.environment[key], key);
    }
    assert.notEqual(web.environment.CACHE_URL, web.environment.TASK_CACHE_URL);
    for (const service of ['lumastra-valkey', 'lumastra-valkey-cache']) {
        assert.equal(worker.depends_on[service].condition, 'service_healthy');
        assert.equal(web.depends_on[service].condition, 'service_healthy');
        assert.equal(config.services[service].profiles, undefined);
    }
    const tasks = config.services['lumastra-valkey'];
    const cache = config.services['lumastra-valkey-cache'];
    assert.match(tasks.command, /--maxmemory-policy noeviction/);
    assert.match(tasks.command, /--appendonly yes/);
    assert.match(tasks.command, /--appendfsync everysec/);
    assert.ok(tasks.volumes.includes('lumastra_valkey_data:/data'));
    assert.match(cache.command, /--maxmemory-policy allkeys-lru/);
    assert.match(cache.command, /--appendonly no/);
    for (const mount of ['config:/config', 'ffmpeg-cache:/config/bin', 'plugins:/app/plugins']) {
        assert.ok(web.volumes.includes(mount));
        assert.ok(worker.volumes.includes(mount));
    }
    // Live TV stays separately opt-in; it cannot be folded into the task worker.
    assert.deepEqual(config.services['lumastra-proxy'].profiles, ['livetv-proxy']);
});

test('development Compose separates evictable cache and persistent task state', async () => {
    const { services } = await load('docker-compose.dev.yml');
    assert.match(services.valkey.command, /--maxmemory-policy noeviction/);
    assert.ok(services.valkey.volumes.includes('valkey_data:/data'));
    assert.match(services['valkey-cache'].command, /--maxmemory-policy allkeys-lru/);
    assert.equal(services['valkey-cache'].profiles, undefined);
});

test('Dex runnable example includes a mandatory worker with a distinct health port', async () => {
    const { services } = await load('docs/examples/oidc-sso-dex/docker-compose.yml');
    const web = services.lumastra;
    const worker = services['lumastra-worker'];
    assert.equal(web.environment.WORKER_MODE, 'disabled');
    assert.notEqual(web.environment.CACHE_URL, web.environment.TASK_CACHE_URL);
    assert.equal(worker.profiles, undefined);
    assert.equal(worker.extends.service, 'lumastra');
    assert.deepEqual(worker.command, ['./start-worker.sh']);
    assert.equal(worker.environment.WORKER_MODE, 'enabled');
    assert.equal(worker.environment.PORT, '3001');
    assert.match(worker.healthcheck.test[1], /127\.0\.0\.1:3001\/api\/health/);
    assert.match(services['valkey-tasks'].command, /--maxmemory-policy noeviction/);
    assert.ok(services['valkey-tasks'].volumes.includes('tasks:/data'));
});
