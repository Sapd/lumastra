// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { Queue, type Job } from 'bullmq';
import IORedis from 'ioredis';
import type postgres from 'postgres';
import { getQueueConnectionOptions } from './connection.js';
import { assertTaskJobOrigin } from '../../../task-runtime/authority/queue-origin.js';
import { AuthorityError, type AuthorityToken } from '../../../task-runtime/authority/store.js';

export class TerminalAttemptUnknownError extends Error {
    constructor(message: string, cause?: unknown) {
        super(message, { cause });
        this.name = 'TerminalAttemptUnknownError';
    }
}

/**
 * The original BullMQ job is absent and PostgreSQL does not confirm the terminal
 * outcome. BullMQ reaps finished jobs, so this observation never resolves by itself.
 */
export class TerminalAttemptJobMissingError extends TerminalAttemptUnknownError {
    constructor() {
        super('UNKNOWN: terminal attempt job unavailable');
        this.name = 'TerminalAttemptJobMissingError';
    }
}

/**
 * Consecutive job-missing observations after which a retained terminal write
 * stops waiting for queue provenance and lets PostgreSQL decide the outcome.
 */
export const TERMINAL_JOB_MISSING_ACCEPT_AFTER = 3;

export interface TerminalQueueAttempt {
    id: string;
    queueName: string;
    prefix: string;
    attemptsStarted: number;
    attemptsMade: number;
}

export function captureTerminalQueueAttempt(
    job: Job | undefined,
): TerminalQueueAttempt | undefined {
    if (
        !job?.id ||
        !job.queueName ||
        !job.queueQualifiedName?.endsWith(`:${job.queueName}`) ||
        !Number.isSafeInteger(job.attemptsStarted) ||
        job.attemptsStarted < 1 ||
        !Number.isSafeInteger(job.attemptsMade) ||
        job.attemptsMade < 0
    )
        return undefined;
    return Object.freeze({
        id: job.id,
        queueName: job.queueName,
        prefix: job.queueQualifiedName.slice(0, -(job.queueName.length + 1)),
        attemptsStarted: job.attemptsStarted,
        attemptsMade: job.attemptsMade,
    });
}

/** A state-only QueueEvents mirror cannot acknowledge a runner's original result. */
export async function terminalResultConfirmed(
    sql: postgres.Sql | postgres.TransactionSql,
    runId: string,
    state: string,
    result: unknown,
): Promise<boolean> {
    const value = result == null ? null : sql.json(result as postgres.JSONValue);
    const rows = await sql<{ state: string; result_matches: boolean }[]>`
        SELECT state, result IS NOT DISTINCT FROM ${value}::jsonb AS result_matches
        FROM task_history WHERE id = ${runId}
    `;
    const row = rows[0];
    return (
        row?.state === 'cancelled' ||
        (row?.state === 'completed' && state !== 'completed') ||
        (row?.state === state && row.result_matches)
    );
}

async function bounded<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            work,
            new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () =>
                        reject(
                            new TerminalAttemptUnknownError(
                                'UNKNOWN: terminal attempt lookup timed out',
                            ),
                        ),
                    2500,
                );
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

/** Observational queue revalidation, never an atomic cross-store attempt fence. */
export async function terminalQueueAttemptCurrent(
    attempt: TerminalQueueAttempt,
    runId: string,
    authority: AuthorityToken | undefined,
    terminalConfirmed: () => Promise<boolean>,
): Promise<boolean> {
    if (
        !attempt ||
        typeof attempt.id !== 'string' ||
        typeof attempt.queueName !== 'string' ||
        typeof attempt.prefix !== 'string' ||
        !attempt.prefix ||
        !Number.isSafeInteger(attempt.attemptsStarted) ||
        attempt.attemptsStarted < 1 ||
        !Number.isSafeInteger(attempt.attemptsMade) ||
        attempt.attemptsMade < 0
    )
        throw new TerminalAttemptUnknownError('UNKNOWN: terminal attempt identity unavailable');
    const connection = getQueueConnectionOptions();
    if (!connection)
        throw new TerminalAttemptUnknownError('UNKNOWN: terminal attempt queue unavailable');
    // Own this short-lived reader's connection; never disconnect a shared worker.
    const client = new IORedis({
        ...connection,
        connectTimeout: 1000,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,
    });
    client.on('error', () => {});
    const queue = new Queue(attempt.queueName, { connection: client, prefix: attempt.prefix });
    queue.on('error', () => {});
    const lookup = async (): Promise<boolean> => {
        const job = await bounded(queue.getJob(attempt.id));
        if (!job) {
            if (await bounded(terminalConfirmed())) return false;
            throw new TerminalAttemptJobMissingError();
        }
        assertTaskJobOrigin(authority, job.data.taskAuthority, job.id);
        if (
            job.data.runId !== runId ||
            !Number.isSafeInteger(job.attemptsStarted) ||
            !Number.isSafeInteger(job.attemptsMade)
        )
            throw new TerminalAttemptUnknownError('UNKNOWN: terminal attempt provenance mismatch');
        if (
            job.attemptsStarted < attempt.attemptsStarted ||
            job.attemptsMade < attempt.attemptsMade
        )
            throw new TerminalAttemptUnknownError('UNKNOWN: terminal attempt counters regressed');
        return (
            job.attemptsStarted === attempt.attemptsStarted &&
            job.attemptsMade <= attempt.attemptsMade + 1
        );
    };
    let result = false;
    let failure: unknown;
    let failed = false;
    try {
        result = await lookup();
    } catch (error) {
        failed = true;
        failure =
            error instanceof AuthorityError || error instanceof TerminalAttemptUnknownError
                ? error
                : new TerminalAttemptUnknownError('UNKNOWN: terminal attempt lookup failed', error);
    }
    // Preserve the lookup's original failure while still releasing every owned reader.
    client.disconnect();
    try {
        await bounded(queue.close());
    } catch (error) {
        if (!failed) {
            failed = true;
            failure = new TerminalAttemptUnknownError(
                'UNKNOWN: terminal attempt reader close failed',
                error,
            );
        }
    }
    if (failed) throw failure;
    return result;
}
