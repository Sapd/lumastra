// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What goes into the Live TV proxy, and a build id over it.
 *
 * The proxy runs on its own pinned image (a restart drops every live channel), so admins
 * update it only when a release changes it. Two consumers share this one definition:
 *
 * - `npm run build:proxy` writes `build/livetv-proxy-build` (the build id over the CODE
 *   inputs). Both proxies report it in their heartbeat and Admin → Cluster compares it
 *   with the app's own file.
 * - `scripts/livetv-proxy-changes.mjs <from> <to>` diffs the inputs between two git refs
 *   for the release notes line ("Live TV proxy: update needed (...)"). It also compares
 *   the Dockerfile stages the proxy runs in, which the image build cannot see (the
 *   Dockerfile is in .dockerignore), so only the release line covers those.
 *
 * Inputs: Rust proxy sources, FFmpeg assets, build/launch scripts and wire contracts.
 * Historical TypeScript sources are included only when comparing old releases.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Directories whose files are all proxy inputs (minus the exclusions below). */
export const PROXY_INPUT_DIRS = ['native/livetv-proxy', 'scripts/ffmpeg'];

/** Single files that build or start the proxy (start-proxy.sh runs fetch-ffmpeg.sh at boot). */
export const PROXY_INPUT_FILES = [
    'deploy/docker/start-proxy.sh',
    'scripts/fetch-ffmpeg.sh',
    'native/rust-toolchain.toml',
    'scripts/build-proxy-metadata.mjs',
    'src/shared/livetv-proxy-protocol.ts',
    'src/shared/livetv-proxy-types.ts',
    'src/shared/livetv-failure-reason.ts',
    'scripts/native.mjs',
];

/**
 * Dockerfile stages the proxy is built or runs in ('' = the final, unnamed stage), with
 * the instructions that count. The final stage is the whole app runtime: only its base
 * image, system setup (RUN), environment and user/entrypoint reach the proxy; its COPY
 * lines bring files already covered by the code inputs or used by web/worker only.
 */
export const PROXY_DOCKERFILE_STAGES = [
    { stage: 'native-builder', instructions: null },
    { stage: '', instructions: ['FROM', 'RUN', 'ENV', 'USER', 'ENTRYPOINT'] },
];

/**
 * Whether a file under an input directory ships in the proxy. Matches what the image
 * build sees: .dockerignore drops *.md, *.test.ts, *.key/*.pem and target/.
 * @param {string} file app-root-relative path
 * @returns {boolean}
 */
export function isShippedProxyFile(file) {
    if (/\.(md|key|pem)$/.test(file) || /(^|\/)\.[^/]+$/.test(file)) return false;
    if (/\.(test|spec)\.[cm]?[jt]s$/.test(file)) return false;
    if (/(^|\/)(__tests__|target|node_modules)\//.test(file)) return false;
    if (
        file.startsWith('native/livetv-proxy/validation/') ||
        file.startsWith('native/livetv-proxy/tests/')
    )
        return false;
    return true;
}

const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.{1,2}\/[^'"]+)['"]/g;

/**
 * Relative import specifiers of a TS/JS module (static, dynamic, type-only, re-exports).
 * @param {string} source
 * @returns {string[]}
 */
export function relativeImports(source) {
    return [...source.matchAll(IMPORT_RE)].map((match) => match[1]);
}

/**
 * Candidate files a relative specifier can resolve to, in resolution order.
 * @param {string} fromFile
 * @param {string} specifier
 * @returns {string[]}
 */
function resolveCandidates(fromFile, specifier) {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
    if (/\.[cm]?js$/.test(base)) return [base.replace(/\.([cm]?)js$/, '.$1ts'), base];
    if (/\.[a-z]+$/.test(base)) return [base];
    return [`${base}.ts`, `${base}/index.ts`];
}

/**
 * @typedef {object} InputReader
 * @property {(dir: string) => string[]} list every file under `dir` (app-root-relative), [] when missing
 * @property {(file: string) => Buffer | null} read file contents, null when missing
 */

/**
 * Every proxy CODE input as app-root-relative paths, sorted. Follows the TypeScript
 * proxy's relative imports out of src/stream-proxy/ transitively.
 * @param {InputReader} reader
 * @returns {string[]}
 */
export function collectProxyInputs(reader) {
    const inputs = new Set();
    // Include the retired source tree only when comparing historical releases.
    if (reader.read('src/stream-proxy/index.ts') !== null) {
        for (const file of reader.list('src/stream-proxy'))
            if (isShippedProxyFile(file)) inputs.add(file);
        if (reader.read('scripts/build-stream-proxy.ts') !== null)
            inputs.add('scripts/build-stream-proxy.ts');
    }

    for (const dir of PROXY_INPUT_DIRS) {
        for (const file of reader.list(dir)) if (isShippedProxyFile(file)) inputs.add(file);
    }
    for (const file of PROXY_INPUT_FILES) if (reader.read(file) !== null) inputs.add(file);

    const queue = [...inputs].filter((file) => /\.[cm]?[jt]s$/.test(file));
    while (queue.length > 0) {
        const file = /** @type {string} */ (queue.pop());
        const source = reader.read(file);
        if (source === null) continue;
        for (const specifier of relativeImports(source.toString('utf8'))) {
            const target = resolveCandidates(file, specifier).find((c) => reader.read(c) !== null);
            if (!target || inputs.has(target) || !isShippedProxyFile(target)) continue;
            inputs.add(target);
            if (/\.[cm]?[jt]s$/.test(target)) queue.push(target);
        }
    }
    return [...inputs].sort();
}

/**
 * The given Dockerfile stages as text: comments and blank lines removed (comment-only
 * edits do not count), continuation lines joined into one instruction, and, where a
 * stage lists `instructions`, only those kept. Stage '' is the final stage; a missing
 * stage is ''.
 * @param {string} dockerfile
 * @param {{ stage: string, instructions: string[] | null }[]} wanted
 * @returns {Record<string, string>}
 */
export function dockerfileStages(dockerfile, wanted) {
    /** @type {string[]} */
    const instructions = [];
    let pending = '';
    for (const line of dockerfile.split('\n')) {
        if (/^\s*(#|$)/.test(line)) continue;
        pending += pending ? ` ${line.trim()}` : line.trim();
        if (pending.endsWith('\\')) {
            pending = pending.slice(0, -1).trimEnd();
            continue;
        }
        instructions.push(pending);
        pending = '';
    }
    if (pending) instructions.push(pending);

    /** @type {{ name: string, lines: string[] }[]} */
    const stages = [];
    for (const instruction of instructions) {
        const from = /^FROM\s+(?:--\S+\s+)*\S+(?:\s+AS\s+(\S+))?/i.exec(instruction);
        if (from) stages.push({ name: from[1] ?? '', lines: [] });
        if (stages.length > 0) stages[stages.length - 1].lines.push(instruction);
    }
    /** @type {Record<string, string>} */
    const picked = {};
    for (const { stage: name, instructions: keep } of wanted) {
        const stage = name === '' ? stages.at(-1) : stages.find((s) => s.name === name);
        const lines = (stage?.lines ?? []).filter(
            (line) => keep === null || keep.includes(line.split(/\s/, 1)[0].toUpperCase()),
        );
        picked[name] = lines.join('\n');
    }
    return picked;
}

/**
 * Git's blob id of the contents: the same in a checkout, in the image build and in
 * `git ls-tree`, so both readers agree without reading blobs twice.
 * @param {Buffer} contents
 * @returns {string}
 */
export function gitBlobId(contents) {
    return createHash('sha1').update(`blob ${contents.length}\0`).update(contents).digest('hex');
}

/**
 * Per-input content ids for the given paths.
 * @param {InputReader} reader
 * @param {string[]} files
 * @returns {Map<string, string>}
 */
export function inputIds(reader, files) {
    const ids = new Map();
    for (const file of files) {
        const contents = reader.read(file);
        if (contents !== null) ids.set(file, gitBlobId(contents));
    }
    return ids;
}

/**
 * Build id over the proxy code inputs: 16 hex characters of a SHA-256 over each path
 * and its blob id. Equal ids mean the same proxy code.
 * @param {InputReader} reader
 * @returns {string}
 */
export function proxyBuildId(reader) {
    const hash = createHash('sha256');
    for (const [file, id] of inputIds(reader, collectProxyInputs(reader))) {
        hash.update(`${file}\0${id}\n`);
    }
    return hash.digest('hex').slice(0, 16);
}

/**
 * Reader over a directory on disk (the app root).
 * @param {string} root
 * @returns {InputReader}
 */
export function fsReader(root) {
    return {
        list(dir) {
            const absolute = path.join(root, dir);
            if (!fs.existsSync(absolute)) return [];
            return fs
                .readdirSync(absolute, { recursive: true, withFileTypes: true })
                .filter((entry) => entry.isFile())
                .map((entry) =>
                    path
                        .relative(root, path.join(entry.parentPath, entry.name))
                        .split(path.sep)
                        .join('/'),
                );
        },
        read(file) {
            try {
                return fs.readFileSync(path.join(root, file));
            } catch {
                return null;
            }
        },
    };
}

/**
 * Reader over a git ref. `prefix` is the app root's path inside the repository
 * ('' in the public repo, 'warp10-dashboard/' in the private one).
 * @param {string} cwd
 * @param {string} ref
 * @param {string} prefix
 * @returns {InputReader}
 */
export function gitReader(cwd, ref, prefix) {
    /** @type {Map<string, Buffer | null>} */
    const cache = new Map();
    const git = (/** @type {string[]} */ args) =>
        execFileSync('git', args, {
            cwd,
            maxBuffer: 256 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
    return {
        list(dir) {
            // --full-tree: paths from the repository root, whatever the cwd.
            return git([
                'ls-tree',
                '-r',
                '--full-tree',
                '--name-only',
                '-z',
                ref,
                '--',
                `${prefix}${dir}/`,
            ])
                .toString('utf8')
                .split('\0')
                .filter(Boolean)
                .map((file) => file.slice(prefix.length));
        },
        read(file) {
            if (!cache.has(file)) {
                try {
                    cache.set(file, git(['cat-file', 'blob', `${ref}:${prefix}${file}`]));
                } catch {
                    cache.set(file, null);
                }
            }
            return cache.get(file) ?? null;
        },
    };
}

/**
 * Writes the build id next to the native proxy (`npm run build:proxy-metadata`).
 * @param {string} root app root
 * @param {string} outFile
 * @returns {string} the id
 */
export function writeProxyBuildId(root, outFile) {
    const id = proxyBuildId(fsReader(root));
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, `${id}\n`);
    return id;
}
