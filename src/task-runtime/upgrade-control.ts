// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { createServer, createConnection, type Socket } from 'node:net';
import { mkdtemp, chmod, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Logger } from '$lib/server/utils/logger.js';

const log = Logger.for('TaskUpgradeControl');

export type UpgradeState = 'idle' | 'preparing' | 'prepared' | 'postponed' | 'unknown' | 'stopping';

export interface UpgradeReceipt {
    pid: number;
    /** Per-boot identifier. Informational only; it does not authorize stop. */
    instance: string;
    state: UpgradeState;
    error?: string;
    /** Stop capability. Present ONLY in the prepare response to its caller. */
    nonce?: string;
}

export const DEFAULT_PREPARED_TIMEOUT_MS = 15 * 60_000;

/** setTimeout overflows to 1 ms above this. */
export const MAX_TIMER_MS = 2_147_483_647;

export function parsePreparedTimeoutMs(raw: string | undefined): number {
    const parsed = Number(raw);
    if (raw === undefined || raw === '' || !Number.isFinite(parsed) || parsed <= 0)
        return DEFAULT_PREPARED_TIMEOUT_MS;
    return Math.min(Math.floor(parsed) || 1, MAX_TIMER_MS);
}

function preparedTimeoutFromEnv(): number {
    return parsePreparedTimeoutMs(process.env.TASK_UPGRADE_PREPARED_TIMEOUT_MS);
}

let activeControl: UpgradeControl | undefined;

/** Current upgrade state of this process; 'idle' when no control is running. */
export function getUpgradeState(): UpgradeState {
    return activeControl?.status().state ?? 'idle';
}

function nonceMatches(expected: string | undefined, presented: unknown): boolean {
    if (!expected || typeof presented !== 'string') return false;
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(presented, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
}

export interface UpgradeControl {
    socketPath: string;
    status: () => UpgradeReceipt;
    close: () => Promise<void>;
}

/** Private same-container operator channel. No HTTP or plugin RPC surface. */
export async function startUpgradeControl(options: {
    prepare: (deadlineMs: number) => Promise<{ prepared: boolean }>;
    resume: () => Promise<void>;
    stop?: () => void;
    preparedTimeoutMs?: number;
}): Promise<UpgradeControl> {
    const preparedTimeoutMs = Math.min(
        options.preparedTimeoutMs && options.preparedTimeoutMs > 0
            ? options.preparedTimeoutMs
            : preparedTimeoutFromEnv(),
        MAX_TIMER_MS,
    );
    const base = process.env.XDG_RUNTIME_DIR || tmpdir();
    const directory = await mkdtemp(join(base, 'lumastra-upgrade-'));
    const socketPath = join(directory, 'control.sock');
    const instance = randomUUID();
    let state: UpgradeReceipt['state'] = 'idle';
    let error: string | undefined;
    let pending: Promise<void> | undefined;
    let closing = false;
    let nonce: string | undefined;
    let preparedTimer: ReturnType<typeof setTimeout> | undefined;
    const clearPreparedTimer = (): void => {
        if (preparedTimer) clearTimeout(preparedTimer);
        preparedTimer = undefined;
    };
    // Invalidate the stop capability BEFORE reopening any claim.
    const startResume = (): Promise<void> => {
        clearPreparedTimer();
        nonce = undefined;
        state = 'preparing';
        error = undefined;
        pending = Promise.resolve()
            .then(() => options.resume())
            .then(() => {
                state = 'idle';
            })
            .catch((failure: unknown) => {
                state = 'unknown';
                error = failure instanceof Error ? failure.message : String(failure);
            })
            .finally(() => {
                pending = undefined;
            });
        return pending;
    };
    const armPreparedTimer = (): void => {
        clearPreparedTimer();
        preparedTimer = setTimeout(() => {
            preparedTimer = undefined;
            if (closing || state !== 'prepared' || pending) return;
            log.error('Upgrade prepared state timed out without stop or resume; resuming', {
                timeoutMs: preparedTimeoutMs,
            });
            void startResume();
        }, preparedTimeoutMs);
        preparedTimer.unref();
    };
    const sockets = new Set<Socket>();
    const status = (): UpgradeReceipt => ({
        pid: process.pid,
        instance,
        state,
        ...(error ? { error } : {}),
    });
    const server = createServer((socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
        socket.setTimeout(60_000, () => socket.destroy());
        let data = '';
        let handled = false;
        socket.on('error', () => {});
        socket.on('data', (chunk: Buffer) => {
            if (handled) return;
            data += chunk.toString('utf8');
            if (Buffer.byteLength(data) > 256) {
                socket.destroy();
                return;
            }
            if (!data.includes('\n')) return;
            handled = true;
            const work = async (): Promise<void> => {
                if (closing) throw new Error('Worker is stopping');
                const request: unknown = JSON.parse(data);
                if (!request || typeof request !== 'object' || !('operation' in request))
                    throw new Error('Invalid upgrade request');
                if (state === 'stopping' && request.operation !== 'status')
                    throw new Error('Worker is stopping');
                if (request.operation === 'stop') {
                    if (
                        state !== 'prepared' ||
                        pending ||
                        !('nonce' in request) ||
                        !nonceMatches(nonce, request.nonce) ||
                        !options.stop
                    )
                        throw new Error('Stop requires the current prepared upgrade nonce');
                    clearPreparedTimer();
                    nonce = undefined;
                    state = 'stopping';
                    socket.end(`${JSON.stringify(status())}\n`, () => options.stop?.());
                    return;
                }
                if (request.operation === 'prepare' && state === 'unknown')
                    throw new Error(
                        'Restore the previous UNKNOWN upgrade operation before preparing again',
                    );
                if (request.operation === 'prepare') {
                    if (!pending && state === 'prepared') {
                        // Never reissue or re-arm: the operator must resume first.
                        socket.end(
                            `${JSON.stringify({ ...status(), error: 'already_prepared' })}\n`,
                        );
                        return;
                    }
                    if (!pending) {
                        state = 'preparing';
                        error = undefined;
                        nonce = undefined;
                        pending = options
                            .prepare(30_000)
                            .then((result) => {
                                state = result.prepared ? 'prepared' : 'postponed';
                                if (result.prepared) {
                                    nonce = randomBytes(32).toString('base64url');
                                    armPreparedTimer();
                                }
                            })
                            .catch((failure: unknown) => {
                                state = 'unknown';
                                error =
                                    failure instanceof Error ? failure.message : String(failure);
                            })
                            .finally(() => {
                                pending = undefined;
                            });
                    }
                    await pending;
                    socket.end(
                        `${JSON.stringify({ ...status(), ...(state === 'prepared' && nonce ? { nonce } : {}) })}\n`,
                    );
                    return;
                } else if (request.operation === 'resume') {
                    if (pending) throw new Error('Upgrade operation is still in progress');
                    // A concurrent stop or a partial restoration failure must
                    // never retain a stale authorization to terminate this owner.
                    await startResume();
                } else if (request.operation !== 'status')
                    throw new Error('Invalid upgrade operation');
                socket.end(`${JSON.stringify(status())}\n`);
            };
            void work().catch((failure: unknown) => {
                socket.end(
                    `${JSON.stringify({ ...status(), error: failure instanceof Error ? failure.message : String(failure) })}\n`,
                );
            });
        });
    });
    server.maxConnections = 4;
    try {
        await chmod(directory, 0o700);
        const info = await stat(directory);
        if (
            (info.mode & 0o777) !== 0o700 ||
            (typeof process.getuid === 'function' && info.uid !== process.getuid())
        )
            throw new Error('Upgrade control directory is not private to this user');
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(socketPath, () => {
                server.removeListener('error', reject);
                resolve();
            });
        });
        await chmod(socketPath, 0o600);
    } catch (failure) {
        server.close();
        await rm(directory, { recursive: true, force: true });
        throw failure;
    }
    const control: UpgradeControl = {
        socketPath,
        status,
        close: async (): Promise<void> => {
            closing = true;
            clearPreparedTimer();
            nonce = undefined;
            if (activeControl === control) activeControl = undefined;
            for (const socket of sockets) socket.destroy();
            await new Promise<void>((resolve, reject) =>
                server.close((failure) => (failure ? reject(failure) : resolve())),
            );
            await rm(directory, { recursive: true, force: true });
        },
    };
    activeControl = control;
    return control;
}

export async function requestUpgrade(
    socketPath: string,
    operation: 'prepare' | 'resume' | 'status' | 'stop',
    nonce?: string,
): Promise<UpgradeReceipt> {
    return new Promise<UpgradeReceipt>((resolve, reject) => {
        const socket = createConnection(socketPath);
        let data = '';
        socket.setTimeout(45_000, () =>
            socket.destroy(new Error('Upgrade response unknown; inspect status before stopping')),
        );
        socket.once('connect', () => socket.write(`${JSON.stringify({ operation, nonce })}\n`));
        socket.once('error', reject);
        socket.on('data', (chunk: Buffer) => {
            data += chunk.toString('utf8');
            if (Buffer.byteLength(data) > 4096)
                socket.destroy(new Error('Invalid upgrade response'));
        });
        socket.once('end', () => {
            try {
                const receipt = JSON.parse(data) as UpgradeReceipt;
                if (
                    !Number.isInteger(receipt.pid) ||
                    typeof receipt.instance !== 'string' ||
                    !['idle', 'preparing', 'prepared', 'postponed', 'unknown', 'stopping'].includes(
                        receipt.state,
                    )
                )
                    throw new Error('Invalid upgrade response');
                resolve(receipt);
            } catch (failure) {
                reject(failure);
            }
        });
        socket.once('close', () => {
            reject(new Error('Upgrade response lost; inspect status before stopping'));
        });
    });
}
