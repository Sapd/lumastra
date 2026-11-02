// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared native-compiler invocation used by both the gate (tsgo-check.mjs) and the
 * headroom canary (headroom-check.mjs).
 *
 * TypeScript 7 — the Go-native compiler this gate has always wanted — is RELEASED
 * now, so the dev preview (`@typescript/native-preview@7.0.0-dev.*`, fetched over
 * the network by `npx` on every run) is gone. It ships as `typescript@7`, installed
 * here under the alias `typescript-go` because the `typescript` dependency itself
 * must stay on 6: TypeScript 7's package contains no JS compiler API at all
 * (`require('typescript').createProgram` is undefined), and @typescript-eslint,
 * svelte-check and svelte2tsx all consume that API. See README.md.
 *
 * The version is pinned by package.json + package-lock.json rather than by a string
 * here, so the gate and the canary cannot drift apart, and CI runs the exact
 * compiler `npm ci` installed instead of whatever the registry serves that minute.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The native compiler binary, addressed by path — `node_modules/.bin/tsc` is
 *  ambiguous while both `typescript` (6) and `typescript-go` (7) are installed. */
export const TSGO_BIN = resolve(REPO_ROOT, 'node_modules/typescript-go/bin/tsc');

/** Matches a real diagnostic line: `path/file.ts(12,34): error TS1234: …`. */
export const ERROR_LINE = /\(\d+,\d+\): error TS\d+/;

/** The two programs the gate checks. Union = the whole project; both must be 0. */
export const CONFIGS = [
    { label: 'src', file: 'tsconfig.typecheck.src.json' },
    { label: 'test', file: 'tsconfig.typecheck.test.json' },
];

/**
 * Run one tsgo pass over `configFile`.
 *
 * @param {string} configFile tsconfig to check
 * @returns {{ errors: string[], launchError: string | null }} matched diagnostic
 *   lines, or a launch failure (tsgo missing/unrunnable — distinct from "found
 *   type errors", which callers must not conflate with success).
 */
export function runPass(configFile) {
    const res = spawnSync(process.execPath, [TSGO_BIN, '--noEmit', '-p', configFile], {
        encoding: 'utf8',
        maxBuffer: 512 * 1024 * 1024,
        cwd: REPO_ROOT,
    });
    if (res.error) return { errors: [], launchError: res.error.message };
    const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    return {
        errors: output.split('\n').filter((line) => ERROR_LINE.test(line)),
        launchError: null,
    };
}
