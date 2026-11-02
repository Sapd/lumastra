// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Build and run the same lean task host as the image, with a supervised watcher.
// npm run dev remains web-only and does not require a Rust toolchain.
import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
function watcherNeedsBuild() {
    try {
        const binary = join(root, 'build/lumastra-watcher');
        accessSync(binary, constants.X_OK);
        const built = statSync(binary);
        if (!built.isFile()) return true;
        const crate = join(root, 'native/watcher');
        const inputs = [join(crate, 'Cargo.toml'), join(crate, 'Cargo.lock')];
        const collect = (directory) => {
            for (const entry of readdirSync(directory, { withFileTypes: true })) {
                const file = join(directory, entry.name);
                if (entry.isDirectory()) collect(file);
                else inputs.push(file);
            }
        };
        collect(join(crate, 'src'));
        return inputs.some((file) => statSync(file).mtimeMs >= built.mtimeMs);
    } catch {
        // Missing/unreadable inputs must go through the build's explicit diagnostics.
        return true;
    }
}

const builds = [
    ['exec', '--', 'svelte-kit', 'sync'],
    ['run', 'paraglide:compile'],
    ...(watcherNeedsBuild() ? [['run', 'build:watcher']] : []),
    ['run', 'build:plugins'],
    ['run', 'build:sandbox'],
    ['run', 'build:task-runtime'],
];
for (const args of builds) {
    const result = spawnSync('npm', args, { cwd: root, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
}
const child = spawn(process.execPath, ['build/task-runtime.js'], {
    cwd: root,
    stdio: 'inherit',
    env: {
        ...process.env,
        WORKER_MODE: 'enabled',
        DEDICATED_WORKER: 'true',
    },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', (error) => {
    console.error(error);
    process.exitCode = 1;
});
child.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1);
});
