// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
    chmod,
    link,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    symlink,
    utimes,
    writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import sirv from 'sirv';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const launcher = fileURLToPath(new URL('../../../deploy/docker/start-worker.sh', import.meta.url));
const webLauncher = fileURLToPath(new URL('../../../deploy/docker/start.sh', import.meta.url));

async function launch(t, entry, env, { watcherBinary = true, setup } = {}) {
    const dir = await mkdtemp(path.join(tmpdir(), 'task-launcher-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    for (const subdir of ['bin', 'build', 'scripts', 'node_modules/.bin'])
        await mkdir(path.join(dir, subdir), { recursive: true });
    for (const [name, source] of [
        [
            'bin/node',
            `#!/bin/sh
if [ "$1" = "scripts/restore-immutable-assets.mjs" ]; then
    exec '${process.execPath.replaceAll("'", "'\\''")}' "$@"
fi
printf "CAPTURE:%s:%s:%s:%s\\n" "$WORKER_MODE" "$DEDICATED_WORKER" "$1" "$NODE_OPTIONS"
`,
        ],
        ['scripts/fetch-ffmpeg.sh', '#!/bin/sh\nprintf fetched > startup-marker\n'],
        ['node_modules/.bin/tsx', '#!/bin/sh\nexit 0\n'],
        // The Rust watcher is the default; start-worker.sh refuses to start without it.
        ...(watcherBinary ? [['build/lumastra-watcher', '#!/bin/sh\nexit 0\n']] : []),
    ]) {
        await writeFile(path.join(dir, name), source);
        await chmod(path.join(dir, name), 0o755);
    }
    await writeFile(
        path.join(dir, 'scripts/restore-immutable-assets.mjs'),
        await readFile(new URL('../../../scripts/restore-immutable-assets.mjs', import.meta.url)),
    );
    await setup?.(dir);
    const restart = () =>
        spawnSync('/bin/sh', [entry], {
            cwd: dir,
            env: {
                PATH: `${path.join(dir, 'bin')}:/usr/bin:/bin`,
                ASSET_HISTORY_DIR: path.join(dir, 'assets'),
                ...env,
            },
            encoding: 'utf8',
            timeout: 5_000,
        });
    const result = restart();
    assert.equal(result.error, undefined);
    return { result, dir, restart };
}

for (const selector of [undefined, '', 'standalone', 'legacy', 'combined', 'auto', 'invalid']) {
    test(`real worker launcher: ${selector ?? 'unset'}`, async (t) => {
        const { result, dir } = await launch(t, launcher, {
            WORKER_MODE: 'disabled',
            DEDICATED_WORKER: 'false',
            ...(selector === undefined ? {} : { LUMASTRA_TASK_RUNTIME: selector }),
        });
        if (selector === undefined || selector === '' || selector === 'standalone') {
            assert.equal(result.status, 0, result.stderr);
            assert.ok(result.stdout.endsWith('CAPTURE:enabled:true:build/task-runtime.js:\n'));
            assert.equal(await readFile(path.join(dir, 'startup-marker'), 'utf8'), 'fetched');
        } else {
            assert.equal(result.status, 64);
            assert.equal(result.stdout, '');
            assert.match(result.stderr, /Unsupported LUMASTRA_TASK_RUNTIME/);
            await assert.rejects(readFile(path.join(dir, 'startup-marker')), { code: 'ENOENT' });
        }
    });
}

test('worker refuses to start without the native watcher binary', async (t) => {
    const { result, dir } = await launch(t, launcher, {}, { watcherBinary: false });
    assert.equal(result.status, 78);
    assert.match(
        result.stderr + result.stdout,
        /build\/lumastra-watcher is missing or not executable/,
    );
    assert.equal(result.stdout.includes('CAPTURE:'), false);
    await assert.rejects(readFile(path.join(dir, 'startup-marker')), { code: 'ENOENT' });
});

test('worker honours LUMASTRA_WATCHER_BINARY for the preflight', async (t) => {
    const { result, dir } = await launch(
        t,
        launcher,
        { LUMASTRA_WATCHER_BINARY: '/nonexistent/lumastra-watcher' },
        { watcherBinary: true },
    );
    assert.equal(result.status, 78);
    assert.match(result.stdout, /\/nonexistent\/lumastra-watcher is missing or not executable/);
    await assert.rejects(readFile(path.join(dir, 'startup-marker')), { code: 'ENOENT' });
});

test('worker preserves the existing heap ceiling', async (t) => {
    const { result } = await launch(t, launcher, {
        LUMASTRA_LOW_RAM_MODE: 'true',
        NODE_OPTIONS: '--max-old-space-size=2048',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(
        result.stdout.endsWith(
            'CAPTURE:enabled:true:build/task-runtime.js:--max-old-space-size=2048\n',
        ),
    );
});

for (const env of [
    {},
    { WORKER_MODE: 'disabled', DEDICATED_WORKER: 'false' },
    { LUMASTRA_LOW_RAM_MODE: 'true' },
]) {
    test(`web launcher always serves HTTP only: ${JSON.stringify(env)}`, async (t) => {
        const { result } = await launch(t, webLauncher, env);
        assert.equal(result.status, 0, result.stderr);
        const heap = env.LUMASTRA_LOW_RAM_MODE ? ' --max-old-space-size=768' : '';
        assert.ok(result.stdout.endsWith(`CAPTURE:disabled:false:build:${heap}\n`));
    });
}

test('web startup exposes retained regular assets to the real static server before hooks', async (t) => {
    const { result, dir, restart } = await launch(
        t,
        webLauncher,
        {},
        {
            setup: async (dir) => {
                const history = path.join(dir, 'assets/nodes');
                const current = path.join(dir, 'build/client/_app/immutable/nodes');
                await mkdir(history, { recursive: true });
                await mkdir(current, { recursive: true });
                await writeFile(path.join(history, '90.old.js'), 'export const old = true;');
                const retainedAge = new Date(Date.now() - 62 * 24 * 60 * 60 * 1000);
                await utimes(path.join(history, '90.old.js'), retainedAge, retainedAge);
                await writeFile(path.join(history, 'shared.js'), 'stale bytes');
                await writeFile(path.join(current, 'shared.js'), 'current bytes');
                await writeFile(path.join(current, '91.new.js'), 'new bytes');
                await writeFile(path.join(dir, 'private.txt'), 'must not serve');
                await symlink(path.join(dir, 'private.txt'), path.join(history, 'unsafe.js'));
                await symlink(dir, path.join(history, 'unsafe-dir'));
            },
        },
    );
    assert.equal(result.status, 0, result.stderr);
    const immutable = path.join(dir, 'build/client/_app/immutable');
    assert.equal((await lstat(path.join(immutable, 'nodes/90.old.js'))).isFile(), true);
    const restoredAge = (await lstat(path.join(immutable, 'nodes/90.old.js'))).mtimeMs;
    assert.ok(Math.abs(Date.now() - restoredAge - 62 * 24 * 60 * 60 * 1000) < 10_000);
    // The real adapter-node asset middleware handles these paths before the
    // framework's early /_app rejection; no SvelteKit handle hook is involved.
    const serve = sirv(path.join(dir, 'build/client'));
    const server = createServer((req, res) =>
        serve(req, res, () => {
            res.writeHead(404).end('framework fallback');
        }),
    );
    t.after(() => new Promise((resolve) => server.close(resolve)));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/_app/immutable/nodes/`;
    const old = await fetch(url + '90.old.js');
    assert.equal(old.status, 200);
    assert.match(old.headers.get('content-type'), /javascript/);
    assert.equal(await old.text(), 'export const old = true;');
    // A second replica pruning the archive must not invalidate sirv's cached
    // file path. The retained asset is an independent regular file.
    await rm(path.join(dir, 'assets/nodes/90.old.js'));
    const afterPrune = await fetch(url + '90.old.js');
    assert.equal(afterPrune.status, 200);
    assert.equal(await afterPrune.text(), 'export const old = true;');
    assert.equal((await fetch(url + '90.old.js', { method: 'HEAD' })).status, 200);
    assert.equal(await (await fetch(url + 'shared.js')).text(), 'current bytes');
    assert.equal(await (await fetch(url + '91.new.js')).text(), 'new bytes');
    for (const missing of ['unsafe.js', 'unsafe-dir/private.txt', '../.builds/private.json']) {
        assert.equal((await fetch(url + missing)).status, 404);
    }
    assert.equal(await readFile(path.join(dir, 'assets/nodes/91.new.js'), 'utf8'), 'new bytes');
    // Re-running startup on the same container filesystem archives regular
    // copies, never links back into their own history directory.
    const restarted = restart();
    assert.equal(restarted.error, undefined);
    assert.equal(restarted.status, 0, restarted.stderr);
    await assert.rejects(lstat(path.join(dir, 'assets/nodes/90.old.js')), { code: 'ENOENT' });
    assert.equal(
        await readFile(path.join(immutable, 'nodes/90.old.js'), 'utf8'),
        'export const old = true;',
    );
    // Restarts must not absorb restored files into this build's manifest.
    const manifests = await readdir(path.join(dir, 'assets/.builds'));
    assert.equal(manifests.length, 2);
    const currentManifest = manifests.find((name) => !name.startsWith('legacy-'));
    assert.deepEqual(
        JSON.parse(await readFile(path.join(dir, 'assets/.builds', currentManifest), 'utf8')).files,
        ['nodes/91.new.js', 'nodes/shared.js'],
    );
});

test('retains old assets from the last three builds and prunes the fourth-newest build', async (t) => {
    const { dir, result, restart } = await launch(
        t,
        webLauncher,
        {},
        {
            setup: async (dir) => {
                const immutable = path.join(dir, 'build/client/_app/immutable/nodes');
                const manifests = path.join(dir, 'assets/.builds');
                await mkdir(immutable, { recursive: true });
                await mkdir(manifests, { recursive: true });
                await mkdir(path.join(dir, 'assets/nodes'), { recursive: true });
                await writeFile(path.join(immutable, 'current.js'), 'current');
                for (let build = 1; build <= 3; build++) {
                    const asset = `nodes/build-${build}.js`;
                    await writeFile(path.join(dir, 'assets', asset), `build ${build}`);
                    const marker = path.join(manifests, `build-${build}.json`);
                    const age = new Date(Date.now() - build * 31 * 86400000);
                    await writeFile(
                        marker,
                        JSON.stringify({
                            files: [asset, 'nodes/shared.js'],
                            recordedAt: age.getTime(),
                        }),
                    );
                    const misleadingMtime = new Date(Date.now() + build * 86400000);
                    await utimes(marker, misleadingMtime, misleadingMtime);
                    await utimes(path.join(dir, 'assets', asset), age, age);
                }
                await writeFile(path.join(dir, 'assets/nodes/shared.js'), 'shared');
            },
        },
    );
    assert.equal(result.status, 0, result.stderr);
    for (const root of ['assets', 'build/client/_app/immutable']) {
        for (const build of [1, 2]) {
            assert.equal(
                await readFile(path.join(dir, root, `nodes/build-${build}.js`), 'utf8'),
                `build ${build}`,
            );
        }
        await assert.rejects(readFile(path.join(dir, root, 'nodes/build-3.js')), {
            code: 'ENOENT',
        });
        assert.equal(await readFile(path.join(dir, root, 'nodes/shared.js'), 'utf8'), 'shared');
    }
    const again = restart();
    assert.equal(again.status, 0, again.stderr);
    assert.equal((await readdir(path.join(dir, 'assets/.builds'))).length, 3);
});

test('read-only build still archives, records and prunes before skipping restore', async (t) => {
    let fixture;
    const locked = [
        'build/client/_app',
        'build/client/_app/immutable',
        'build/client/_app/immutable/nodes',
    ];
    try {
        const { dir, result, restart } = await launch(
            t,
            webLauncher,
            { ASSET_HISTORY_BUILDS: '2' },
            {
                setup: async (dir) => {
                    fixture = dir;
                    await mkdir(path.join(dir, 'build/client/_app/immutable/nodes'), {
                        recursive: true,
                    });
                    await mkdir(path.join(dir, 'assets/.builds'), { recursive: true });
                    await mkdir(path.join(dir, 'assets/nodes'), { recursive: true });
                    await writeFile(
                        path.join(dir, 'build/client/_app/immutable/nodes/current.js'),
                        'current',
                    );
                    for (const [name, recordedAt] of [
                        ['previous', 200],
                        ['expired', 100],
                    ]) {
                        await writeFile(path.join(dir, `assets/nodes/${name}.js`), name);
                        await writeFile(
                            path.join(dir, `assets/.builds/${name}.json`),
                            JSON.stringify({
                                files: [`nodes/${name}.js`],
                                recordedAt,
                            }),
                        );
                    }
                    for (const relative of locked) await chmod(path.join(dir, relative), 0o555);
                },
            },
        );
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stderr, /skipped restore into non-writable build directory/);
        assert.doesNotMatch(result.stderr, /could not be restored|EROFS|EACCES/);
        assert.equal(await readFile(path.join(dir, 'assets/nodes/current.js'), 'utf8'), 'current');
        assert.equal(
            await readFile(path.join(dir, 'assets/nodes/previous.js'), 'utf8'),
            'previous',
        );
        await assert.rejects(readFile(path.join(dir, 'assets/nodes/expired.js')), {
            code: 'ENOENT',
        });
        await assert.rejects(
            readFile(path.join(dir, 'build/client/_app/immutable/nodes/previous.js')),
            { code: 'ENOENT' },
        );
        assert.equal((await readdir(path.join(dir, 'assets/.builds'))).length, 2);
        const again = restart();
        assert.equal(again.status, 0, again.stderr);
        assert.match(again.stderr, /skipped restore into non-writable build directory/);
        assert.equal((await readdir(path.join(dir, 'assets/.builds'))).length, 2);
    } finally {
        if (fixture)
            for (const relative of locked) await chmod(path.join(fixture, relative), 0o755);
    }
});

test('truncated manifests are quarantined and old array manifests are upgraded atomically', async (t) => {
    const { dir, result, restart } = await launch(
        t,
        webLauncher,
        {},
        {
            setup: async (dir) => {
                await mkdir(path.join(dir, 'assets/.builds'), { recursive: true });
                await mkdir(path.join(dir, 'assets/nodes'), { recursive: true });
                await mkdir(path.join(dir, 'build/client/_app/immutable/nodes'), {
                    recursive: true,
                });
                await writeFile(path.join(dir, 'assets/.builds/truncated.json'), '["nodes/');
                await writeFile(path.join(dir, 'assets/.builds/old.json'), '["nodes/old.js"]');
                const oldTime = new Date(Date.now() - 86400000);
                await utimes(path.join(dir, 'assets/.builds/old.json'), oldTime, oldTime);
                await writeFile(path.join(dir, 'assets/nodes/old.js'), 'old');
                await writeFile(
                    path.join(dir, 'build/client/_app/immutable/nodes/current.js'),
                    'current',
                );
            },
        },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /skipped unreadable manifest truncated.json/);
    assert.doesNotMatch(result.stderr, /could not be restored/);
    const old = JSON.parse(await readFile(path.join(dir, 'assets/.builds/old.json'), 'utf8'));
    assert.deepEqual(old.files, ['nodes/old.js']);
    assert.ok(old.recordedAt < Date.now() - 80000000);
    assert.equal(
        await readFile(path.join(dir, 'build/client/_app/immutable/nodes/old.js'), 'utf8'),
        'old',
    );
    const again = restart();
    assert.equal(again.status, 0, again.stderr);
    assert.doesNotMatch(again.stderr, /unreadable manifest/);
    const names = await readdir(path.join(dir, 'assets/.builds'));
    assert.ok(names.includes('truncated.json.invalid'));
    assert.ok(names.every((name) => !name.endsWith('.tmp')));
    assert.equal(
        JSON.parse(await readFile(path.join(dir, 'assets/.builds/old.json'), 'utf8')).recordedAt,
        old.recordedAt,
    );
});

test('a restarted older build stays recorded and old unmanifested assets expire', async (t) => {
    const { dir, result, restart } = await launch(
        t,
        webLauncher,
        { ASSET_HISTORY_BUILDS: '1' },
        {
            setup: async (dir) => {
                await mkdir(path.join(dir, 'build/client/_app/immutable/nodes'), {
                    recursive: true,
                });
                await writeFile(
                    path.join(dir, 'build/client/_app/immutable/nodes/current.js'),
                    'current',
                );
            },
        },
    );
    assert.equal(result.status, 0, result.stderr);
    const manifestDir = path.join(dir, 'assets/.builds');
    const [runningName] = await readdir(manifestDir);
    const running = JSON.parse(await readFile(path.join(manifestDir, runningName), 'utf8'));
    running.recordedAt = 1;
    await writeFile(path.join(manifestDir, runningName), JSON.stringify(running));
    await writeFile(
        path.join(manifestDir, 'newer.json'),
        JSON.stringify({ files: ['nodes/newer.js'], recordedAt: Date.now() }),
    );
    for (const name of ['newer', 'orphan-old', 'orphan-recent'])
        await writeFile(path.join(dir, `assets/nodes/${name}.js`), name);
    const oldTime = new Date(Date.now() - 31 * 86400000);
    await utimes(path.join(dir, 'assets/nodes/orphan-old.js'), oldTime, oldTime);
    const again = restart();
    assert.equal(again.status, 0, again.stderr);
    assert.deepEqual(await readdir(manifestDir), [runningName]);
    assert.equal(
        JSON.parse(await readFile(path.join(manifestDir, runningName), 'utf8')).recordedAt,
        1,
    );
    for (const name of ['newer', 'orphan-old'])
        await assert.rejects(readFile(path.join(dir, `assets/nodes/${name}.js`)), {
            code: 'ENOENT',
        });
    assert.equal(
        await readFile(path.join(dir, 'assets/nodes/orphan-recent.js'), 'utf8'),
        'orphan-recent',
    );
});

test('huge flat legacy history is bounded without argument spreads or a startup stall', async (t) => {
    const { dir, result } = await launch(
        t,
        webLauncher,
        { ASSET_HISTORY_TIMEOUT_MS: '1500' },
        {
            setup: async (dir) => {
                const root = path.join(dir, 'assets/legacy');
                await mkdir(root, { recursive: true });
                await mkdir(path.join(dir, 'build/client/_app/immutable/nodes'), {
                    recursive: true,
                });
                await writeFile(
                    path.join(dir, 'build/client/_app/immutable/nodes/current.js'),
                    'current',
                );
                // Exceeds the recursive spread limit without allocating file data.
                for (let offset = 0; offset < 130000; offset += 500) {
                    const seed = path.join(root, `seed-${offset}.js`);
                    await writeFile(seed, 'legacy');
                    await Promise.all(
                        Array.from({ length: 500 }, (_, n) =>
                            link(seed, path.join(root, `${offset + n}.js`)),
                        ),
                    );
                }
            },
        },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /CAPTURE:disabled:false:build/);
    assert.match(result.stderr, /skipped legacy adoption: archive exceeds 10000 files/);
    assert.match(result.stderr, /deadline reached/);
    assert.doesNotMatch(result.stderr, /RangeError|could not be restored/);
    assert.equal(await readFile(path.join(dir, 'assets/nodes/current.js'), 'utf8'), 'current');
    assert.equal((await readdir(path.join(dir, 'assets/.builds'))).length, 1);
    await assert.rejects(readFile(path.join(dir, 'build/client/_app/immutable/legacy/seed-0.js')), {
        code: 'ENOENT',
    });
});

test('asset maintenance deadline releases startup during a stalled filesystem operation', async (t) => {
    const { result } = await launch(
        t,
        webLauncher,
        { ASSET_HISTORY_TIMEOUT_MS: '100' },
        {
            setup: async (dir) => {
                await mkdir(path.join(dir, 'build/client/_app/immutable'), { recursive: true });
                // Exercise the real shell backstop with a short test duration.
                await writeFile(
                    path.join(dir, 'bin/timeout'),
                    `#!/bin/sh
[ "$1" = "-s" ] && [ "$2" = "KILL" ] && [ "$3" = "60s" ] || exit 64
shift 3
exec /usr/bin/timeout -s KILL 1s "$@"
`,
                );
                await chmod(path.join(dir, 'bin/timeout'), 0o755);
                // A FIFO makes the asset subprocess wait on a real read.
                const made = spawnSync(
                    'mkfifo',
                    [path.join(dir, 'build/client/_app/version.json')],
                    { encoding: 'utf8' },
                );
                assert.equal(made.status, 0, made.stderr);
            },
        },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /deadline reached/);
    assert.match(result.stderr, /maintenance failed or timed out; skipped remaining work/);
    assert.match(result.stdout, /CAPTURE:disabled:false:build/);
});

for (const env of [
    { WORKER_MODE: 'enabled' },
    { WORKER_MODE: 'auto' },
    { DEDICATED_WORKER: 'true' },
    { WORKER_MODE: 'disabled', DEDICATED_WORKER: 'true' },
]) {
    test(`web rejects worker roles before startup side effects: ${JSON.stringify(env)}`, async (t) => {
        const { result, dir } = await launch(t, webLauncher, env);
        assert.equal(result.status, 64);
        assert.match(result.stderr, /Web startup requires WORKER_MODE=disabled/);
        await assert.rejects(readFile(path.join(dir, 'startup-marker')), { code: 'ENOENT' });
    });
}

for (const scenario of [
    'missing',
    'fresh',
    'nested source',
    'manifest',
    'lockfile',
    'equal timestamp',
]) {
    test(`development worker watcher freshness: ${scenario}`, async (t) => {
        const dir = await mkdtemp(path.join(tmpdir(), 'dev-task-launcher-'));
        t.after(() => rm(dir, { recursive: true, force: true }));
        await mkdir(path.join(dir, 'scripts'), { recursive: true });
        await mkdir(path.join(dir, 'bin'), { recursive: true });
        await mkdir(path.join(dir, 'build'), { recursive: true });
        await writeFile(
            path.join(dir, 'scripts/dev-worker.mjs'),
            await readFile(new URL('../../../scripts/dev-worker.mjs', import.meta.url)),
        );
        const npm = path.join(dir, 'bin/npm');
        await writeFile(npm, '#!/bin/sh\nprintf "%s\\n" "$*" >> builds\n');
        await chmod(npm, 0o755);
        await writeFile(
            path.join(dir, 'build/task-runtime.js'),
            'console.log(JSON.stringify({mode: process.env.WORKER_MODE, dedicated: process.env.DEDICATED_WORKER}));',
        );
        const crate = path.join(dir, 'native/watcher');
        await mkdir(path.join(crate, 'src/nested'), { recursive: true });
        const sources = ['Cargo.toml', 'Cargo.lock', 'src/main.rs', 'src/nested/policy.rs'];
        const older = new Date('2020-01-01T00:00:00Z');
        const built = new Date('2020-01-02T00:00:00Z');
        const newer = new Date('2020-01-03T00:00:00Z');
        for (const file of sources) {
            await writeFile(path.join(crate, file), 'fixture');
            await utimes(path.join(crate, file), older, older);
        }
        if (scenario !== 'missing') {
            const binary = path.join(dir, 'build/lumastra-watcher');
            await writeFile(binary, '#!/bin/sh\nexit 0\n');
            await chmod(binary, 0o755);
            await utimes(binary, built, built);
        }
        const dirty = {
            'nested source': 'src/nested/policy.rs',
            manifest: 'Cargo.toml',
            lockfile: 'Cargo.lock',
            'equal timestamp': 'src/main.rs',
        }[scenario];
        if (dirty) {
            const modified = scenario === 'equal timestamp' ? built : newer;
            await utimes(path.join(crate, dirty), modified, modified);
        }
        const result = spawnSync(process.execPath, ['scripts/dev-worker.mjs'], {
            cwd: dir,
            env: {
                PATH: `${path.join(dir, 'bin')}:/usr/bin:/bin`,
            },
            encoding: 'utf8',
            timeout: 5_000,
        });
        assert.equal(result.error, undefined);
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), {
            mode: 'enabled',
            dedicated: 'true',
        });
        assert.deepEqual((await readFile(path.join(dir, 'builds'), 'utf8')).trim().split('\n'), [
            'exec -- svelte-kit sync',
            'run paraglide:compile',
            ...(scenario === 'fresh' ? [] : ['run build:watcher']),
            'run build:plugins',
            'run build:sandbox',
            'run build:task-runtime',
        ]);
    });
}
