// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Admission control for every entry into `runAssistant`: a per-user
 * requests-per-minute limit and a per-user in-flight slot. The HTTP route
 * admits up front (so it can answer 429 before opening an SSE stream) and hands
 * `runAssistant` the ticket; any other caller (the plugin `ctx.ai` bridge)
 * arrives without one and `runAssistant` admits it here itself.
 *
 * The daily token budget stays in `runAssistant`; it is checked before the run
 * and recorded after it, which leaves a window that only the in-flight slot
 * closes.
 *
 * @module server/proprietary/assistant-admission
 */
import { randomUUID } from 'node:crypto';
import { AiUnavailableError } from '@sapd/lumastra-plugin-sdk';
import { getAiConfig } from '$lib/server/config/domains/ai.js';
import { Logger } from '$lib/server/utils/logger';

const logger = Logger.for('AssistantAdmission');

/**
 * Slots are members of a per-user sorted set that expire INDIVIDUALLY. A held
 * slot is refreshed by a heartbeat, so a run longer than the TTL keeps its slot;
 * a crashed holder's slot is swept after the TTL. Releasing is idempotent, so
 * the counter can never go negative (a bare INCR/DECR with a one-shot EXPIRE
 * lost its key mid-run and the later DECR granted an extra slot).
 */
const SLOT_TTL_SECONDS = 300;
const SLOT_HEARTBEAT_MS = 100_000;

/** Fallbacks for an invalid configured limit (the schema defaults). */
const DEFAULT_REQUESTS_PER_MINUTE = 10;
const DEFAULT_MAX_CONCURRENT = 2;

/** A held in-flight slot. `release` is idempotent. */
export interface AssistantAdmission {
    release(): Promise<void>;
}

export type AssistantAdmissionKind = 'rate_limited' | 'too_many_concurrent';

/**
 * Refusal to start a run. Extends `AiUnavailableError` so a plugin sees the
 * same "AI not available" error class it already handles.
 */
export class AssistantAdmissionError extends AiUnavailableError {
    readonly kind: AssistantAdmissionKind;
    /** Epoch seconds when the per-minute window resets (rate_limited only). */
    readonly resetAt?: number;
    constructor(kind: AssistantAdmissionKind, resetAt?: number) {
        super(
            kind === 'rate_limited'
                ? 'AI assistant request limit reached. Try again in a minute.'
                : 'AI assistant is already busy with your other requests.',
        );
        this.name = 'AssistantAdmissionError';
        this.kind = kind;
        this.resetAt = resetAt;
    }
}

/**
 * A configured limit. `undefined` means "not configured" (no limit applies; the
 * real config always supplies a number). A non-integer, negative or NaN value is
 * a misconfiguration and falls back to the schema default, with a warning. An
 * explicit 0 stays 0: nothing is admitted, as it did before this moved here.
 */
function effectiveLimit(name: string, value: unknown, fallback: number): number | null {
    if (value === undefined) return null;
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
    logger.warn(`Invalid ${name}; using the default`, { value: String(value), fallback });
    return fallback;
}

/**
 * Admit one run for `userId`, or throw {@link AssistantAdmissionError}.
 * Fails OPEN when Valkey is unavailable (availability over strictness), exactly
 * as the route did before this moved here.
 */
export async function admitAssistantRun(userId: string): Promise<AssistantAdmission> {
    const ai = getAiConfig();
    const none: AssistantAdmission = { release: async (): Promise<void> => {} };

    const rpmLimit = effectiveLimit(
        'ASSISTANT_REQUESTS_PER_MINUTE',
        ai.assistantRequestsPerMinute,
        DEFAULT_REQUESTS_PER_MINUTE,
    );
    if (rpmLimit !== null) {
        const { checkRateLimit } = await import('$lib/server/middleware/valkey-rate-limit');
        const rpm = await checkRateLimit(`assistant-rpm:${userId}`, rpmLimit, 60);
        if (!rpm.allowed) throw new AssistantAdmissionError('rate_limited', rpm.resetAt);
    }

    const maxConcurrent = effectiveLimit(
        'ASSISTANT_MAX_CONCURRENT',
        ai.assistantMaxConcurrent,
        DEFAULT_MAX_CONCURRENT,
    );
    if (maxConcurrent === null) return none;

    const { zAddBoundedExpiring, zRem } = await import('$lib/server/cache/valkey');
    const key = `assistant:slots:${userId}`;
    const slotId = `slot-${randomUUID()}`;
    const admitted = await zAddBoundedExpiring(key, slotId, maxConcurrent, SLOT_TTL_SECONDS, {
        failOpen: true,
    });
    if (!admitted) throw new AssistantAdmissionError('too_many_concurrent');

    // Re-adding the same member refreshes its score, so a long run keeps its slot.
    const heartbeat = setInterval(() => {
        void zAddBoundedExpiring(key, slotId, maxConcurrent, SLOT_TTL_SECONDS, {
            failOpen: true,
        });
    }, SLOT_HEARTBEAT_MS);
    heartbeat.unref();

    let released = false;
    return {
        release: async (): Promise<void> => {
            if (released) return;
            released = true;
            clearInterval(heartbeat);
            await zRem(key, slotId);
        },
    };
}
