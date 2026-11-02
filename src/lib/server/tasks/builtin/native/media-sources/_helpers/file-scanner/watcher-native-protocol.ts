// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { NativeWatcherPolicyV2 } from '../../../../../../utils/media-file-kinds.js';

export const NATIVE_WATCHER_PROTOCOL_VERSION = 2;
export const NATIVE_WATCHER_MAX_LINE_BYTES = 1024 * 1024;
/** Interval at which the child's main loop emits `alive`; Node treats 3x silence as wedged. */
export const NATIVE_WATCHER_ALIVE_MS = 10_000;
export const NATIVE_WATCHER_LIVENESS_FACTOR = 3;
export const NATIVE_WATCHER_NETWORK_RECONCILE_MIN_SECS = 60;
export const NATIVE_WATCHER_NETWORK_RECONCILE_MAX_SECS = 86_400;

export type { NativeWatcherPolicyV2 };

export interface NativeWatcherInit {
    type: 'init';
    version: 2;
    paths: string[];
    networkPaths: string[];
    /** 0 disables the periodic reconcile of network roots; otherwise 60..86400. */
    networkReconcileSecs: number;
    policy: NativeWatcherPolicyV2;
    stabilityMs: 500;
    pollMs: 100;
    aliveMs: number;
}

export type NativeWatcherErrorCode = 'watch_limit' | 'permission' | 'io' | 'backend';
const ERROR_CODES: ReadonlySet<string> = new Set(['watch_limit', 'permission', 'io', 'backend']);

export interface NativeWatcherStatus {
    coverage: 'full' | 'partial';
    watchedDirs: number;
    failedDirs: number;
    failedSample: string[];
    watchLimit: boolean;
    nonUtf8Skipped: number;
    refusedSymlinks: number;
    networkRoots: string[];
    /** A filesystem probe is stalled (hung mount); coverage is partial while set. */
    stalledProbes: boolean;
    /** Directories that exist but are not watched; coverage is partial while > 0. */
    unwatchedDirs: number;
    /**
     * Library roots whose filesystem calls have not returned within the child's deadline
     * (hung mount). The other roots are still observed; coverage is partial while non-empty.
     */
    stalledRoots: string[];
}

export type NativeWatcherMessage =
    | { type: 'ready'; version: 2 }
    | { type: 'event'; event: 'add' | 'change' | 'unlink'; path: string }
    | ({ type: 'status' } & NativeWatcherStatus)
    | { type: 'error'; message: string; fatal: boolean; code?: NativeWatcherErrorCode }
    | { type: 'rescan'; reason: string }
    | { type: 'alive'; seq: number };

function counter(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function stringArray(value: unknown): string[] | null {
    return Array.isArray(value) && value.every((item) => typeof item === 'string')
        ? (value as string[])
        : null;
}

export function parseNativeWatcherMessage(line: string): NativeWatcherMessage {
    const value: unknown = JSON.parse(line);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('Native watcher emitted a non-object message');
    }
    const record = value as Record<string, unknown>;
    if (record.type === 'ready' && record.version === NATIVE_WATCHER_PROTOCOL_VERSION) {
        return { type: 'ready', version: 2 };
    }
    if (
        record.type === 'event' &&
        (record.event === 'add' || record.event === 'change' || record.event === 'unlink') &&
        typeof record.path === 'string' &&
        record.path.length > 0 &&
        !record.path.includes('\0')
    ) {
        return { type: 'event', event: record.event, path: record.path };
    }
    if (
        record.type === 'error' &&
        typeof record.message === 'string' &&
        typeof record.fatal === 'boolean' &&
        (record.code === undefined ||
            (typeof record.code === 'string' && ERROR_CODES.has(record.code)))
    ) {
        return {
            type: 'error',
            message: record.message,
            fatal: record.fatal,
            ...(record.code === undefined ? {} : { code: record.code as NativeWatcherErrorCode }),
        };
    }
    if (record.type === 'rescan' && typeof record.reason === 'string') {
        return { type: 'rescan', reason: record.reason };
    }
    if (record.type === 'alive') {
        const seq = counter(record.seq);
        if (seq !== null) return { type: 'alive', seq };
    }
    if (record.type === 'status') {
        const watchedDirs = counter(record.watchedDirs);
        const failedDirs = counter(record.failedDirs);
        const nonUtf8Skipped = counter(record.nonUtf8Skipped);
        const refusedSymlinks = counter(record.refusedSymlinks);
        const failedSample = stringArray(record.failedSample);
        const networkRoots = stringArray(record.networkRoots);
        const unwatchedDirs =
            record.unwatchedDirs === undefined ? 0 : counter(record.unwatchedDirs);
        const stalledProbes = record.stalledProbes === undefined ? false : record.stalledProbes;
        const stalledRoots =
            record.stalledRoots === undefined ? [] : stringArray(record.stalledRoots);
        if (
            unwatchedDirs !== null &&
            stalledRoots !== null &&
            typeof stalledProbes === 'boolean' &&
            (record.coverage === 'full' || record.coverage === 'partial') &&
            watchedDirs !== null &&
            failedDirs !== null &&
            nonUtf8Skipped !== null &&
            refusedSymlinks !== null &&
            failedSample !== null &&
            networkRoots !== null &&
            typeof record.watchLimit === 'boolean'
        ) {
            return {
                type: 'status',
                coverage: record.coverage,
                watchedDirs,
                failedDirs,
                failedSample: failedSample.slice(0, 5),
                watchLimit: record.watchLimit,
                nonUtf8Skipped,
                refusedSymlinks,
                networkRoots,
                stalledProbes,
                unwatchedDirs,
                stalledRoots,
            };
        }
    }
    throw new Error('Native watcher emitted an incompatible protocol message');
}

/** True when `--version` output (`lumastra-watcher <ver> protocol 2`) names our protocol. */
export function nativeWatcherVersionOutputCompatible(output: string): boolean {
    return new RegExp(`\\bprotocol ${NATIVE_WATCHER_PROTOCOL_VERSION}\\b`).test(output);
}
