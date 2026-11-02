// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Explicit native build entry point. Missing crates, locks or tooling fail rather
// than silently skipping a component. Does not select a production implementation.
import { spawnSync } from 'node:child_process';
import {
    chmodSync,
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    renameSync,
    rmdirSync,
    unlinkSync,
    readFileSync,
    readdirSync,
    realpathSync,
    writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const components = {
    watcher: 'lumastra-watcher',
    'livetv-proxy': 'lumastra-livetv-proxy',
    'task-queue': 'lumastra-task-queue',
};
const actions = new Set(['check', 'test', 'test-release', 'build', 'licenses', 'smoke']);

function run(command, args, capture = false) {
    const result = spawnSync(command, args, {
        cwd: root,
        env: { ...process.env, CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? '2' },
        encoding: 'utf8',
        stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
        maxBuffer: 32 * 1024 * 1024,
    });
    if (result.error) {
        if (result.error.code === 'ENOENT' && ['cargo', 'rustup'].includes(command)) {
            throw new Error(
                'Rust toolchain required: install rustup, then the pinned toolchain (see native/rust-toolchain.toml)',
            );
        }
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(`${command} failed (${result.signal ?? result.status})`);
    }
    return result.stdout ?? '';
}

function licenseTexts(pkg) {
    const packageRoot = realpathSync(dirname(pkg.manifest_path));
    const files = readdirSync(packageRoot, { withFileTypes: true })
        .filter(
            (entry) => entry.isFile() && /^(licen[cs]e|copying|notice)([._-]|$)/i.test(entry.name),
        )
        .map((entry) => entry.name);
    if (pkg.license_file) files.push(pkg.license_file);
    return [...new Set(files)].sort().map((name) => {
        const path = realpathSync(resolve(packageRoot, name));
        const rel = relative(packageRoot, path);
        if (rel === '..' || rel.startsWith(`..${sep}`)) {
            throw new Error(`License file escapes package: ${pkg.name}`);
        }
        return { file: name, text: readFileSync(path, 'utf8') };
    });
}

function main() {
    const [action, component, ...extra] = process.argv.slice(2);
    if (!actions.has(action) || !Object.hasOwn(components, component) || extra.length > 0) {
        throw new Error(
            'Usage: node scripts/native.mjs <check|test|test-release|build|licenses|smoke> <watcher|livetv-proxy|task-queue>',
        );
    }
    const binaryName = components[component];
    const manifest = join(root, 'native', component, 'Cargo.toml');
    if (!existsSync(manifest) || !existsSync(join(dirname(manifest), 'Cargo.lock'))) {
        throw new Error(`Native manifest and committed Cargo.lock required: ${component}`);
    }
    const packageVersion = readFileSync(manifest, 'utf8').match(/^version\s*=\s*"([^"]+)"/m)?.[1];
    if (!packageVersion) throw new Error('An explicit native package version is required');
    const toolchain = readFileSync(join(root, 'native/rust-toolchain.toml'), 'utf8').match(
        /^channel\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+)"\s*$/m,
    )?.[1];
    if (!toolchain) throw new Error('An exact native Rust toolchain pin is required');
    for (const file of ['Dockerfile', 'native/Dockerfile']) {
        const source = join(root, file);
        if (existsSync(source)) {
            const compiler = readFileSync(source, 'utf8').match(
                /^FROM\s+(?:--platform=\S+\s+)?rust:([0-9]+\.[0-9]+\.[0-9]+)-[^\s]+/m,
            )?.[1];
            if (compiler !== toolchain) throw new Error(`Rust compiler pin drift: ${file}`);
        }
    }
    for (const file of [
        join(root, '.github/workflows/native.yml'),
        join(root, '../.github/workflows/native.yml'),
    ]) {
        if (existsSync(file)) {
            const pins = [
                ...readFileSync(file, 'utf8').matchAll(
                    /rustup toolchain install ([0-9]+\.[0-9]+\.[0-9]+)/g,
                ),
            ];
            if (pins.length === 0 || pins.some((pin) => pin[1] !== toolchain))
                throw new Error('Rust CI compiler pin drift');
        }
    }
    const cargo = (args, capture = false) => run('cargo', [`+${toolchain}`, ...args], capture);
    const common = ['--manifest-path', manifest, '--locked'];

    if (action === 'check') {
        cargo(['fmt', '--manifest-path', manifest, '--all', '--', '--check']);
        cargo(['clippy', ...common, '--all-targets', '--', '-D', 'warnings']);
        cargo(['test', ...common]);
    } else if (action === 'test' || action === 'test-release') {
        cargo(['test', ...common, ...(action === 'test-release' ? ['--release'] : [])]);
    } else if (action === 'build') {
        const output = cargo(['build', ...common, '--release', '--message-format=json'], true);
        const executable = output
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line))
            .find(
                (item) =>
                    item.reason === 'compiler-artifact' &&
                    item.target?.name === binaryName &&
                    item.target?.kind?.includes('bin') &&
                    item.executable,
            )?.executable;
        if (!executable) throw new Error(`Cargo did not produce ${binaryName}`);
        mkdirSync(join(root, 'build'), { recursive: true });
        const destination = join(root, 'build', binaryName);
        const temporaryDirectory = mkdtempSync(join(root, 'build/.native-publish-'));
        const temporaryFile = join(temporaryDirectory, binaryName);
        try {
            copyFileSync(executable, temporaryFile);
            chmodSync(temporaryFile, 0o755);
            renameSync(temporaryFile, destination);
        } finally {
            if (existsSync(temporaryFile)) unlinkSync(temporaryFile);
            rmdirSync(temporaryDirectory);
        }
        console.log(`Built ${binaryName}`);
    } else if (action === 'licenses') {
        const metadata = JSON.parse(cargo(['metadata', ...common, '--format-version', '1'], true));
        const packages = metadata.packages
            .map((pkg) => {
                if (!pkg.license && !pkg.license_file) {
                    throw new Error(`License metadata missing: ${pkg.name}@${pkg.version}`);
                }
                return {
                    name: pkg.name,
                    version: pkg.version,
                    source: pkg.source,
                    license: pkg.license,
                    repository: pkg.repository,
                    texts: licenseTexts(pkg),
                };
            })
            .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
        const directory = join(root, 'build/native-licenses');
        mkdirSync(directory, { recursive: true });
        writeFileSync(
            join(directory, `${component}.json`),
            JSON.stringify(
                {
                    component,
                    toolchain,
                    scope: 'Locked Cargo metadata, including development and non-target packages',
                    packagesWithoutNoticeFiles: packages
                        .filter((pkg) => pkg.texts.length === 0)
                        .map((pkg) => `${pkg.name}@${pkg.version}`),
                    packages,
                },
                null,
                2,
            ) + '\n',
        );
        console.log(`Recorded ${packages.length} native package licenses for ${component}`);
    } else {
        const version = run(join(root, 'build', binaryName), ['--version'], true).trim();
        const [name, reportedVersion] = version.split(/\s+/);
        if (name !== binaryName || reportedVersion !== packageVersion) {
            throw new Error(
                `Unexpected native executable identity: expected ${binaryName} ${packageVersion}`,
            );
        }
        console.log(version);
    }
}

try {
    main();
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
}
