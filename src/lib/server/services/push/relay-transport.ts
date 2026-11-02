// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `RelayTransport` — the v1 `PushTransport`: posts to the Lumastra-operated
 * relay (`config.PUSH_RELAY_URL`), which holds Apple's signing key so
 * operators never handle a `.p8`. Authenticates with the short-lived
 * relay-scoped token from `relay-token.store.ts`, not the license JWT.
 *
 * @module services/push/relay-transport
 */

import { config } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';
import { fetchWithTimeout } from '$lib/server/utils/fetch-utils.js';
import {
    PushTransportError,
    type PushRequest,
    type PushResult,
    type PushTransport,
} from './push-transport.js';
import { getRelayToken, invalidateRelayToken } from './relay-token.store.js';

const log = Logger.for('RelayTransport');

/**
 * Hard per-call timeout.
 *
 * `push-outbox.ts`'s `CLAIM_TTL_SECONDS` docblock spells out the budget this
 * has to respect: one delivery pass claims up to `BATCH_SIZE` (50) rows for
 * `CLAIM_TTL_SECONDS` (300s), each row makes one transport call per
 * (bundle, environment, locale) group, and "at 50 rows × ~2 groups that
 * leaves ~3s per call" — with nothing enforcing it, so a hung relay can blow
 * the claim TTL and let a second replica re-claim rows that are still in
 * flight (a double-send, only masked by `apns-collapse-id`).
 *
 * This is that enforcement. 2.5s rather than the full ~3s leaves headroom for
 * the per-row DB work (notification lookup, badge count, mark-delivered/dead
 * writes) that shares the same claim window but happens outside `send()`.
 */
const SEND_TIMEOUT_MS = 2_500;

interface RelaySendResponseBody {
    results: PushResult[];
}

/**
 * A device token is a credential: anyone holding it plus our relay's topic
 * can push to that device. Never emit more than a correlation-length prefix.
 */
function tokenPreview(token: string): string {
    return `${token.slice(0, 8)}...`;
}

function tokensLogSummary(tokens: string[]): string | { count: number } {
    return tokens.length === 1 ? tokenPreview(tokens[0]) : { count: tokens.length };
}

export class RelayTransport implements PushTransport {
    /**
     * `timeoutMs` defaults to `SEND_TIMEOUT_MS` and exists as a constructor
     * parameter (rather than the module constant used directly) only so a
     * test can substitute a short real timeout — Node's `AbortSignal.timeout`
     * runs on the native timer binding, not the `setTimeout` that
     * `vi.useFakeTimers()` patches, so faking the clock cannot exercise it.
     */
    constructor(private readonly timeoutMs: number = SEND_TIMEOUT_MS) {}

    async send(req: PushRequest): Promise<PushResult[]> {
        const token = getRelayToken();
        if (!token) {
            // NOT 'unauthenticated'. Nothing was sent and nothing was rejected —
            // this install simply has no credential (PUSH_RELAY_TOKEN unset and
            // no licence-minted token). Retrying a configuration fact six times
            // and then reporting `max_attempts` would describe a relay outage
            // that never happened.
            throw new PushTransportError('no relay credential configured', 'no_credential');
        }
        return this.attempt(req, token, /* allowRetry */ true);
    }

    /**
     * One HTTP attempt. `token` is captured once by the caller and reused
     * verbatim on the single 401 retry — invalidating the store affects only
     * FUTURE calls, not the in-flight retry, which still needs a bearer value
     * to send.
     *
     * This is also why a 401 costs at most one extra `SEND_TIMEOUT_MS` call
     * per `send()`, never a compounding one: `push-outbox.ts`'s
     * `CLAIM_TTL_SECONDS` docblock budgets ~3s per transport call assuming
     * ONE call each, and a naive retry-with-a-fresh-token would still be one
     * call per `send()`. The retry here reuses the now-invalidated token
     * instead of re-reading the store, so the SECOND attempt 401s too and
     * every OTHER group in the same delivery pass sees `getRelayToken()`
     * return `null` and short-circuits to an immediate `unauthenticated`
     * throw with no fetch at all — the doubling is bounded to one call, one
     * time, per pass. A future change that re-fetches a fresh token before
     * retrying would silently break that bound, since every group could then
     * pay for two full-length calls instead of zero or one.
     */
    private async attempt(
        req: PushRequest,
        token: string,
        allowRetry: boolean,
    ): Promise<PushResult[]> {
        let res: Response;
        try {
            // C22 fix round 1: PUSH_RELAY_URL is deliberately
            // admin-configurable (a self-hoster can point it at their own
            // relay) and this call carries a Bearer credential — same class
            // as the twelve sites the C22 finding migrated. Routed through
            // the same-origin-only redirect guard; fetchWithTimeout also
            // enforces this.timeoutMs (SEND_TIMEOUT_MS in production) — a
            // timeout throws FetchTimeoutError here, caught below and
            // surfaced as 'transient' so the row takes the ladder, same as
            // the previous AbortSignal.timeout-driven DOMException did.
            res = await fetchWithTimeout(
                `${config.PUSH_RELAY_URL}/api/push/send`,
                {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        Authorization: `Bearer ${token}`,
                    },
                    body: JSON.stringify({
                        bundleId: req.bundleId,
                        environment: req.environment,
                        pushType: 'alert',
                        priority: 10,
                        collapseId: req.collapseId,
                        expirationEpochSeconds: req.expirationEpochSeconds,
                        tokens: req.tokens,
                        payload: req.payload,
                    }),
                },
                this.timeoutMs,
            );
        } catch (err) {
            log.warn('RelayTransport: request failed', {
                tokens: tokensLogSummary(req.tokens),
                err: err instanceof Error ? err.message : String(err),
            });
            throw new PushTransportError('relay request failed', 'transient');
        }

        if (res.status === 401) {
            invalidateRelayToken();
            if (allowRetry) {
                return this.attempt(req, token, false);
            }
            log.warn('RelayTransport: unauthenticated after retry', {
                tokens: tokensLogSummary(req.tokens),
            });
            throw new PushTransportError('relay rejected credential', 'unauthenticated');
        }

        if (res.status === 403) {
            log.warn('RelayTransport: not entitled', { tokens: tokensLogSummary(req.tokens) });
            throw new PushTransportError('relay: not entitled', 'not_entitled');
        }

        if (res.status === 429) {
            const retryAfterHeader = res.headers.get('Retry-After');
            const parsed = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : NaN;
            const retryAfterSeconds = Number.isFinite(parsed) ? parsed : undefined;
            log.warn('RelayTransport: throttled', {
                tokens: tokensLogSummary(req.tokens),
                retryAfterSeconds,
            });
            throw new PushTransportError('relay throttled', 'throttled', retryAfterSeconds);
        }

        if (res.status === 400) {
            log.warn('RelayTransport: invalid request', { tokens: tokensLogSummary(req.tokens) });
            throw new PushTransportError('relay rejected request', 'invalid');
        }

        if (res.status >= 500) {
            log.warn('RelayTransport: relay server error', {
                tokens: tokensLogSummary(req.tokens),
                status: res.status,
            });
            throw new PushTransportError('relay server error', 'transient');
        }

        if (!res.ok) {
            log.warn('RelayTransport: unexpected relay status', {
                tokens: tokensLogSummary(req.tokens),
                status: res.status,
            });
            throw new PushTransportError('relay returned an unexpected status', 'transient');
        }

        let data: RelaySendResponseBody;
        try {
            data = (await res.json()) as RelaySendResponseBody;
        } catch (err) {
            log.warn('RelayTransport: could not parse relay response', {
                tokens: tokensLogSummary(req.tokens),
                err: err instanceof Error ? err.message : String(err),
            });
            throw new PushTransportError('relay response was not valid JSON', 'transient');
        }

        // A 200 with a body that parses but doesn't carry a `results` array
        // (e.g. `{}`) would otherwise return `undefined` here and only
        // explode one layer away, inside PushOutbox.sendGroup's
        // `for (const r of results)` — diagnosed as "transport threw a
        // non-transport error" instead of at the actual fault. Same outcome
        // (transient, rides the ladder), better diagnostics.
        if (!Array.isArray(data.results)) {
            log.warn('RelayTransport: relay response missing results array', {
                tokens: tokensLogSummary(req.tokens),
            });
            throw new PushTransportError('relay response missing results array', 'transient');
        }

        return data.results;
    }
}
