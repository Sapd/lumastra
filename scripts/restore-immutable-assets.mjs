// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import {
    copyFile,
    lstat,
    mkdir,
    opendir,
    readFile,
    rename,
    rm,
    utimes,
    writeFile,
} from 'node:fs/promises';
import path from 'node:path';

const [historyArg, destinationArg] = process.argv.slice(2);
if (!historyArg || !destinationArg) {
    throw new Error('Expected asset history and current immutable asset directories');
}
const history = path.resolve(historyArg);
const destination = path.resolve(destinationArg);
const manifests = path.join(history, '.builds');
const snapshots = path.join(history, '.snapshots');
const configured = Number(process.env.ASSET_HISTORY_BUILDS ?? 3);
if (!Number.isSafeInteger(configured) || configured < 1) {
    throw new Error('ASSET_HISTORY_BUILDS must be a positive integer');
}

const LEGACY_LIMIT = 10_000;
const MANIFEST_LIMIT = 100_000;
const ORPHAN_WINDOW_MS = 30 * 86400000;
// A shorter budget is useful to operators; the hard maximum is always 60s.
const requestedBudget = Number(process.env.ASSET_HISTORY_TIMEOUT_MS ?? 60_000);
const budget =
    Number.isFinite(requestedBudget) && requestedBudget > 0
        ? Math.min(requestedBudget, 60_000)
        : 60_000;
const deadline = Date.now() + budget;
const warn = (message) => console.warn(`Asset history: ${message}`);
const expired = new Error('deadline reached; skipped remaining asset maintenance');
function checkDeadline() {
    if (Date.now() >= deadline) throw expired;
}
// Stop pending asynchronous work promptly; start.sh also has a hard kill
// timeout because Node can wait for a filesystem worker even during exit.
const timer = setTimeout(() => {
    warn(expired.message);
    process.exit(0);
}, budget);

async function* filesIn(root, relative = '') {
    checkDeadline();
    try {
        if (!(await lstat(path.join(root, relative))).isDirectory()) return;
        const directory = await opendir(path.join(root, relative));
        for await (const entry of directory) {
            checkDeadline();
            if (entry.name.startsWith('.')) continue;
            const child = path.join(relative, entry.name);
            if (entry.isDirectory()) yield* filesIn(root, child);
            else if (entry.isFile()) yield child;
        }
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
}

async function collectFiles(root, limit) {
    const files = [];
    for await (const file of filesIn(root)) {
        if (files.length === limit) return null;
        files.push(file);
    }
    return files.sort();
}

async function copyAsset(sourceRoot, targetRoot, file) {
    checkDeadline();
    const source = path.join(sourceRoot, file);
    const target = path.join(targetRoot, file);
    try {
        const metadata = await lstat(source);
        if (!metadata.isFile()) return;
        // Never follow a persistent symlink directory on either side. Reading
        // the immutable image must not require mkdir/write access to it.
        for (const root of [sourceRoot, targetRoot]) {
            let dir = root;
            if (root === targetRoot) await mkdir(dir, { recursive: true });
            if (!(await lstat(dir)).isDirectory()) return;
            for (const part of path.dirname(file).split(path.sep)) {
                dir = path.join(dir, part);
                if (root === targetRoot) await mkdir(dir, { recursive: true });
                if (!(await lstat(dir)).isDirectory()) return;
            }
        }
        // Hashed names never change content, so a same-size target is complete. Copy through a
        // temp file and rename, so a kill mid-copy never leaves a truncated asset behind.
        try {
            const existing = await lstat(target);
            if (existing.isFile() && existing.size === metadata.size) return;
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        const temporary = path.join(path.dirname(target), `.${randomUUID()}.tmp`);
        try {
            await copyFile(source, temporary, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
            await utimes(temporary, metadata.atime, metadata.mtime);
            await rename(temporary, target);
        } finally {
            await rm(temporary, { force: true });
        }
    } catch (error) {
        if (error.code !== 'EEXIST' && error.code !== 'ENOENT') throw error;
    }
}

async function writeJson(file, value) {
    checkDeadline();
    const temporary = path.join(path.dirname(file), `.${randomUUID()}.tmp`);
    try {
        await writeFile(temporary, JSON.stringify(value), { flag: 'wx' });
        await rename(temporary, file);
    } finally {
        await rm(temporary, { force: true });
    }
}

function validateFiles(files) {
    if (
        !Array.isArray(files) ||
        files.length > MANIFEST_LIMIT ||
        files.some(
            (file) =>
                typeof file !== 'string' ||
                file.includes('\0') ||
                path.isAbsolute(file) ||
                file.split(/[\\/]/).some((part) => !part || part === '..' || part.startsWith('.')),
        )
    )
        throw new Error('Invalid asset build manifest');
    return files;
}

async function readJson(file) {
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.size > 8 * 1024 * 1024)
        throw new Error('Invalid or oversized asset state file');
    return { value: JSON.parse(await readFile(file, 'utf8')), metadata };
}

async function loadBuild(file) {
    try {
        const { value, metadata } = await readJson(file);
        // Upgrade old array manifests once, preserving their original order.
        const files = validateFiles(Array.isArray(value) ? value : value.files);
        const recordedAt = Array.isArray(value) ? metadata.mtimeMs : value.recordedAt;
        if (!Number.isFinite(recordedAt) || recordedAt < 0)
            throw new Error('Invalid build recording time');
        if (Array.isArray(value)) await writeJson(file, { files, recordedAt });
        return { file, files, recordedAt };
    } catch (error) {
        if (error === expired) throw error;
        if (error.code !== 'ENOENT') {
            warn(`skipped unreadable manifest ${path.basename(file)} (${error.message})`);
            // A partial manifest from an older launcher must not poison every
            // subsequent start. Quarantine it outside the active namespace.
            await rename(file, `${file}.invalid`).catch(() => {});
        }
        return null;
    }
}

async function recordBuild(files, builds, prefix = '') {
    if (files.length === 0) return null;
    const id = prefix + createHash('sha256').update(JSON.stringify(files)).digest('hex');
    const file = path.join(manifests, `${id}.json`);
    const existing = builds.find((build) => build.file === file);
    if (existing) return existing;
    const build = { file, files, recordedAt: Date.now() };
    await writeJson(file, { files, recordedAt: build.recordedAt });
    builds.push(build);
    return build;
}

async function removeAsset(file) {
    checkDeadline();
    let dir = history;
    for (const part of path.dirname(file).split(path.sep)) {
        dir = path.join(dir, part);
        try {
            if (!(await lstat(dir)).isDirectory()) return;
        } catch (error) {
            if (error.code === 'ENOENT') return;
            throw error;
        }
    }
    await rm(path.join(history, file), { force: true });
}

async function maintain() {
    for (const dir of [manifests, snapshots]) {
        await mkdir(dir, { recursive: true });
        if (!(await lstat(dir)).isDirectory()) throw new Error('Invalid asset state directory');
    }
    const builds = [];
    let hadManifest = false;
    for await (const entry of await opendir(manifests)) {
        checkDeadline();
        if (!entry.name.endsWith('.json') || entry.name.startsWith('.')) continue;
        hadManifest = true;
        const build = await loadBuild(path.join(manifests, entry.name));
        if (build) builds.push(build);
    }

    // Image version identifies replicas of the same build. The directory
    // identity also distinguishes image trees without a SvelteKit version file.
    const metadata = await lstat(destination).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
        return null;
    });
    const version = await readFile(path.join(destination, '../version.json'), 'utf8').catch(
        (error) => {
            if (error.code !== 'ENOENT') throw error;
            return `${destination}:${metadata?.dev}:${metadata?.ino}:${metadata?.birthtimeMs}`;
        },
    );
    const snapshot = path.join(
        snapshots,
        `${createHash('sha256').update(version).digest('hex')}.json`,
    );
    let current;
    try {
        current = validateFiles((await readJson(snapshot)).value);
    } catch (error) {
        if (error.code !== 'ENOENT') warn(`rebuilding unreadable snapshot (${error.message})`);
        // Migrate the old writable-container snapshot without writing beside
        // the build tree again. Production read-only images never had one.
        try {
            current = validateFiles((await readJson(`${destination}.asset-history.json`)).value);
        } catch {
            current = await collectFiles(destination, MANIFEST_LIMIT);
        }
        if (!current) throw new Error('Current build exceeds asset file limit', { cause: error });
        await writeJson(snapshot, current);
    }
    // Archive and record the current image before any potentially large legacy
    // scan, pruning or optional restore. No writes to build/client are needed.
    for (const file of current) await copyAsset(destination, history, file);
    const running = await recordBuild(current, builds);

    if (!hadManifest) {
        const legacy = await collectFiles(history, LEGACY_LIMIT);
        if (legacy) {
            const currentFiles = new Set(current);
            await recordBuild(
                legacy.filter((file) => !currentFiles.has(file)),
                builds,
                'legacy-',
            );
        } else {
            warn(
                `skipped legacy adoption: archive exceeds ${LEGACY_LIMIT} files; fallback can still serve them`,
            );
        }
    }
    builds.sort((a, b) => b.recordedAt - a.recordedAt || b.file.localeCompare(a.file));
    // Rollbacks/restarts may run an older build. Always reserve one slot for it.
    const retained = running ? [running] : [];
    for (const build of builds) {
        if (build !== running && retained.length < configured) retained.push(build);
    }
    const kept = new Set();
    for (const build of retained) for (const file of build.files) kept.add(file);
    const referenced = new Set();
    for (const build of builds) for (const file of build.files) referenced.add(file);
    for (const build of builds) {
        if (retained.includes(build)) continue;
        for (const file of build.files) if (!kept.has(file)) await removeAsset(file);
        await rm(build.file, { force: true });
    }
    // Failed/interrupted copies and skipped legacy assets must eventually age
    // out too. Give unreferenced files a 30-day grace period for other replicas.
    for await (const file of filesIn(history)) {
        if (referenced.has(file)) continue;
        const stat = await lstat(path.join(history, file)).catch((error) => {
            if (error.code !== 'ENOENT') throw error;
            return null;
        });
        if (stat?.mtimeMs < Date.now() - ORPHAN_WINDOW_MS) await removeAsset(file);
    }
    // A read-only image is normal in production. The fallback handler serves
    // history directly, so stop restoring cleanly on the first write denial.
    for (const file of kept) {
        try {
            await copyAsset(history, destination, file);
        } catch (error) {
            if (!['EROFS', 'EACCES', 'EPERM'].includes(error.code)) throw error;
            warn('skipped restore into non-writable build directory; using asset history fallback');
            break;
        }
    }
}

try {
    await maintain();
} catch (error) {
    if (error !== expired) throw error;
    warn(expired.message);
} finally {
    clearTimeout(timer);
}
