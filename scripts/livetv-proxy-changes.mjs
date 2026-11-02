#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Does a release change the Live TV proxy? Prints the release-notes line.
 *
 *   node scripts/livetv-proxy-changes.mjs <from-ref> [<to-ref>=HEAD] [--line] [--exit-code]
 *
 * Compares every proxy input (scripts/livetv-proxy-inputs.mjs) plus the Dockerfile
 * stages the proxy builds and runs in. Prints
 *
 *   Live TV proxy: update needed (TypeScript proxy, shared modules)
 *   Live TV proxy: no update needed
 *
 * followed by the changed paths, unless --line. --exit-code exits 1 when an update is
 * needed. <from-ref> is the previous release (the stable commit prod runs, or the last
 * release tag); <to-ref> what is being released.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    PROXY_DOCKERFILE_STAGES,
    collectProxyInputs,
    dockerfileStages,
    gitReader,
    inputIds,
} from './livetv-proxy-inputs.mjs';

const PROTOCOL_FILE = 'src/shared/livetv-proxy-protocol.ts';
const MIN_PROTOCOL_FILE = 'src/lib/server/services/livetv/proxy-compat.ts';

const AREA_ORDER = [
    'TypeScript proxy',
    'Rust proxy',
    'shared modules',
    'build scripts',
    'image build',
];

/** Area a changed input belongs to, for the short reason in the line. */
export function inputArea(/** @type {string} */ file) {
    if (file.startsWith('Dockerfile')) return 'image build';
    if (file.startsWith('native/')) return 'Rust proxy';
    if (file.startsWith('src/stream-proxy/')) return 'TypeScript proxy';
    if (file.startsWith('src/shared/')) return 'shared modules';
    return 'build scripts';
}

/**
 * @param {import('./livetv-proxy-inputs.mjs').InputReader} reader
 * @param {string} file
 * @param {RegExp} pattern
 * @returns {number | undefined}
 */
function readNumber(reader, file, pattern) {
    const match = pattern.exec(reader.read(file)?.toString('utf8') ?? '');
    return match ? Number(match[1]) : undefined;
}

/**
 * Proxy inputs of one side. No proxy entry point means a wrong ref or path prefix, which
 * would otherwise compare two empty sets and print "no update needed".
 * @param {import('./livetv-proxy-inputs.mjs').InputReader} reader
 * @param {string} side
 * @returns {string[]}
 */
function requireInputs(reader, side) {
    const inputs = collectProxyInputs(reader);
    if (
        !inputs.includes('native/livetv-proxy/src/main.rs') &&
        !inputs.includes('src/stream-proxy/index.ts')
    ) {
        throw new Error(`no Live TV proxy sources found at the ${side} ref (wrong ref or path?)`);
    }
    return inputs;
}

/**
 * The comparison behind the line. Pure over two readers, so tests use in-memory trees.
 * @param {import('./livetv-proxy-inputs.mjs').InputReader} from
 * @param {import('./livetv-proxy-inputs.mjs').InputReader} to
 * @returns {{ needed: boolean, changed: string[], line: string }}
 */
export function compareProxyInputs(from, to) {
    const before = inputIds(from, requireInputs(from, 'from'));
    const after = inputIds(to, requireInputs(to, 'to'));
    const changed = [...new Set([...before.keys(), ...after.keys()])]
        .filter((file) => before.get(file) !== after.get(file))
        .sort();

    const stagesBefore = dockerfileStages(
        from.read('Dockerfile')?.toString('utf8') ?? '',
        PROXY_DOCKERFILE_STAGES,
    );
    const stagesAfter = dockerfileStages(
        to.read('Dockerfile')?.toString('utf8') ?? '',
        PROXY_DOCKERFILE_STAGES,
    );
    for (const { stage } of PROXY_DOCKERFILE_STAGES) {
        if (stagesBefore[stage] !== stagesAfter[stage]) {
            changed.push(`Dockerfile (${stage === '' ? 'runtime' : stage} stage)`);
        }
    }

    if (changed.length === 0) {
        return { needed: false, changed, line: 'Live TV proxy: no update needed' };
    }
    const reasons = AREA_ORDER.filter((area) => changed.some((file) => inputArea(file) === area));
    const protocolPattern = /LIVETV_PROXY_PROTOCOL\s*=\s*(\d+)/;
    const minPattern = /LIVETV_PROXY_MIN_PROTOCOL\s*=\s*(\d+)/;
    const protocolBefore = readNumber(from, PROTOCOL_FILE, protocolPattern) ?? 0;
    const protocolAfter = readNumber(to, PROTOCOL_FILE, protocolPattern) ?? 0;
    if (protocolBefore !== protocolAfter) {
        const min = readNumber(to, MIN_PROTOCOL_FILE, minPattern) ?? 0;
        reasons.unshift(
            min > protocolBefore
                ? `protocol ${protocolBefore} → ${protocolAfter}, the old proxy no longer works with this release`
                : `protocol ${protocolBefore} → ${protocolAfter}`,
        );
    }
    return { needed: true, changed, line: `Live TV proxy: update needed (${reasons.join(', ')})` };
}

function main(/** @type {string[]} */ argv) {
    const args = argv.filter((arg) => !arg.startsWith('--'));
    if (args.length < 1 || args.length > 2) {
        process.stderr.write(
            'usage: node scripts/livetv-proxy-changes.mjs <from-ref> [<to-ref>] [--line] [--exit-code]\n',
        );
        process.exit(2);
    }
    const [fromRef, toRef = 'HEAD'] = args;
    try {
        run(fromRef, toRef, argv);
    } catch (error) {
        // Exit 2, never 1: with --exit-code, 1 means "update needed".
        process.stderr.write(
            `livetv-proxy-changes: ${error instanceof Error ? error.message : error}\n`,
        );
        process.exit(2);
    }
}

function run(
    /** @type {string} */ fromRef,
    /** @type {string} */ toRef,
    /** @type {string[]} */ argv,
) {
    const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const prefix = execFileSync('git', ['rev-parse', '--show-prefix'], { cwd: appRoot })
        .toString('utf8')
        .trim();
    for (const ref of [fromRef, toRef]) {
        try {
            execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
                cwd: appRoot,
                stdio: 'ignore',
            });
        } catch {
            throw new Error(`unknown git ref '${ref}' (fetch it first)`);
        }
    }
    const result = compareProxyInputs(
        gitReader(appRoot, fromRef, prefix),
        gitReader(appRoot, toRef, prefix),
    );
    process.stdout.write(`${result.line}\n`);
    if (!argv.includes('--line')) {
        for (const file of result.changed) process.stdout.write(`  ${file}\n`);
    }
    if (argv.includes('--exit-code') && result.needed) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main(process.argv.slice(2));
}
