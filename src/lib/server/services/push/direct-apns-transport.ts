// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `DirectApnsTransport` — the operator bring-your-own-certificate path.
 *
 * This is the AGPL core's unpaid route to push, and the reason gating the
 * Lumastra relay closes nothing that was open: an operator who signs and
 * distributes their own iOS build puts their own Apple `.p8` in config and this
 * server talks to `api.push.apple.com` itself, with no Lumastra service in the
 * path and no licence involved.
 *
 * 🔴 **APNs has no batch endpoint.** One notification to N devices is N
 * separate HTTP/2 requests to `POST /3/device/<deviceToken>`; there is no array
 * of tokens anywhere in Apple's protocol. `PushRequest` carries N tokens purely
 * because the delivery pass groups them by `(bundle, environment, locale)`, and
 * turning that group into N upstream requests is this module's whole job. An
 * implementation that sends only the first token still returns a
 * plausible-looking `PushResult[]` and still reports `ok` for every device, so
 * the failure is silent — which is why the tests assert the upstream request
 * count and not just the shape of what comes back.
 *
 * The N requests multiplex as concurrent streams over a small pool of
 * kept-alive HTTP/2 connections per host, not a connection each.
 *
 * @module services/push/direct-apns-transport
 */

import { Pool, type Dispatcher } from 'undici';
import { Logger } from '$lib/server/utils/logger.js';
import type { ApnsCredential } from './apns-credential.js';
import { mapApnsResponse, parseApnsReason } from './apns-reason-map.js';
import { ProviderTokenStore } from './apns-provider-token.js';
import {
    PushTransportError,
    type PushRequest,
    type PushResult,
    type PushTokenStatus,
    type PushTransport,
} from './push-transport.js';

const log = Logger.for('DirectApnsTransport');

export const APNS_HOST_PRODUCTION = 'https://api.push.apple.com';
export const APNS_HOST_SANDBOX = 'https://api.sandbox.push.apple.com';

/**
 * Hard per-call timeout — the same 2.5s `RelayTransport` enforces, for the same
 * reason.
 *
 * `push-outbox.ts`'s `CLAIM_TTL_SECONDS` docblock spells out the budget: one
 * delivery pass claims up to `BATCH_SIZE` (50) rows for `CLAIM_TTL_SECONDS`
 * (300s), each row makes one transport call per (bundle, environment, locale)
 * group, and "at 50 rows × ~2 groups that leaves ~3s per call" — with the
 * docblock noting that NOTHING in the `PushTransport` contract enforces it, so
 * a hung upstream can blow the claim TTL and let a second replica re-claim rows
 * still in flight (a double-send, only masked by `apns-collapse-id`).
 *
 * This is that enforcement for the direct path. 2.5s rather than the full ~3s
 * leaves headroom for the per-row DB work (notification lookup, badge count,
 * mark-delivered/dead writes) that shares the claim window but happens outside
 * `send()`.
 */
const SEND_TIMEOUT_MS = 2_500;

/**
 * Per-token ceiling, inside the whole-call budget above.
 *
 * Both exist because they fail differently. Without the per-token timeout one
 * slow device holds a stream until the whole-call deadline fires and takes
 * every other token's outcome down with it; without the whole-call deadline N
 * slow tokens each wait the per-token timeout and the sum overruns the claim
 * budget.
 */
const REQUEST_TIMEOUT_MS = 1_500;

const PROVIDER_TOKEN_TTL_MS = 40 * 60_000;
const MIN_REMINT_INTERVAL_MS = 20_000;
const CONNECTIONS_PER_HOST = 2;
const MAX_CONCURRENT_STREAMS = 100;

export type ApnsDispatcherFactory = (origin: string) => Dispatcher;

export interface DirectApnsTransportOptions {
    credential: ApnsCredential;
    /** Overridden only by tests, which point both at a local HTTP/2 server. */
    hosts?: { production: string; sandbox: string };
    /** Whole-call budget. Defaults to {@link SEND_TIMEOUT_MS}. */
    sendTimeoutMs?: number;
    /** Per-token ceiling. Defaults to {@link REQUEST_TIMEOUT_MS}. */
    requestTimeoutMs?: number;
    providerTokenTtlMs?: number;
    minRemintIntervalMs?: number;
    connectionsPerHost?: number;
    maxConcurrentStreams?: number;
    /** Overridden in tests to trust a local self-signed certificate. */
    dispatcherFactory?: ApnsDispatcherFactory;
    /** Injectable clock for the provider-token TTL. Tests only. */
    now?: () => number;
}

/** What one upstream attempt produced, before it becomes a `PushResult`. */
interface AttemptOutcome {
    status: PushTokenStatus;
    /** Apple's `reason`, for the log line only. Never returned to the caller. */
    reason?: string;
    statusCode?: number;
    apnsId?: string;
    /** True when the failure was the deadline rather than an answer from Apple. */
    timedOut?: boolean;
}

/**
 * A device token is a credential: anyone holding it plus our topic can push to
 * that device. Never emit more than a correlation-length prefix — and never put
 * one in a thrown `Error` message, because `push-outbox.ts` logs `errMsg(err)`
 * verbatim.
 *
 * Same shape as the previews in `relay-transport.ts` and `push-outbox.ts`, so
 * one device correlates across all three.
 */
function tokenPreview(token: string): string {
    return `${token.slice(0, 8)}...`;
}

export class DirectApnsTransport implements PushTransport {
    readonly #hosts: { production: string; sandbox: string };
    readonly #sendTimeoutMs: number;
    readonly #requestTimeoutMs: number;
    readonly #tokenStore: ProviderTokenStore;
    readonly #factory: ApnsDispatcherFactory;
    readonly #dispatchers = new Map<string, Dispatcher>();

    constructor(options: DirectApnsTransportOptions) {
        this.#hosts = options.hosts ?? {
            production: APNS_HOST_PRODUCTION,
            sandbox: APNS_HOST_SANDBOX,
        };
        this.#sendTimeoutMs = options.sendTimeoutMs ?? SEND_TIMEOUT_MS;
        this.#requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
        this.#tokenStore = new ProviderTokenStore({
            keyP8: options.credential.keyP8,
            keyId: options.credential.keyId,
            teamId: options.credential.teamId,
            ttlMs: options.providerTokenTtlMs ?? PROVIDER_TOKEN_TTL_MS,
            minRemintIntervalMs: options.minRemintIntervalMs ?? MIN_REMINT_INTERVAL_MS,
            ...(options.now ? { now: options.now } : {}),
        });

        const connections = options.connectionsPerHost ?? CONNECTIONS_PER_HOST;
        const streams = options.maxConcurrentStreams ?? MAX_CONCURRENT_STREAMS;
        this.#factory =
            options.dispatcherFactory ??
            ((origin) =>
                new Pool(origin, {
                    allowH2: true,
                    connections,
                    // 🔴 `pipelining` is undici's cap on requests in flight per
                    // connection, and it defaults to 1 even over HTTP/2 — the
                    // `defaultPipelining: Infinity` that `client-h2.js`
                    // advertises is unreachable, because the Client constructor
                    // writes a concrete 1 before it can be consulted. Left
                    // alone, one connection carries one stream at a time.
                    pipelining: streams,
                    keepAliveTimeout: 60_000,
                    keepAliveMaxTimeout: 10 * 60_000,
                    connect: { timeout: 1_000 },
                }));
    }

    /**
     * Send one payload to every token.
     *
     * @returns exactly one `PushResult` per token in `req.tokens`, in the same
     *   order. `push-outbox.ts` matches results back to tokens by value and
     *   treats a missing token as a failure, so a short array is a real bug
     *   rather than a tolerated shortcut.
     * @throws PushTransportError `transient` when the whole-call deadline fired
     *   and NOT ONE token got an answer — nothing was learned, so this is the
     *   same "the call failed" the relay path reports on a fetch timeout. A
     *   partially-answered call returns its results instead: the tokens Apple
     *   did answer for carry real outcomes (including `gone`, which retires a
     *   dead device), and discarding them to report one uniform failure would
     *   throw that away and re-send to everyone next attempt.
     */
    async send(req: PushRequest): Promise<PushResult[]> {
        const origin = this.#hosts[req.environment];
        const dispatcher = this.#dispatcherFor(origin);
        const body = Buffer.from(JSON.stringify(req.payload), 'utf8');
        const deadline = AbortSignal.timeout(this.#sendTimeoutMs);
        const headers = baseHeaders(req);

        const outcomes = await Promise.all(
            req.tokens.map(async (token): Promise<{ token: string; outcome: AttemptOutcome }> => {
                const outcome = await this.#sendOne({
                    token,
                    dispatcher,
                    headers,
                    body,
                    deadline,
                    allowRemint: true,
                });

                if (outcome.status !== 'ok') {
                    log.warn('token not delivered', {
                        token: tokenPreview(token),
                        status: outcome.status,
                        statusCode: outcome.statusCode,
                        reason: outcome.reason,
                        apnsId: outcome.apnsId,
                        environment: req.environment,
                    });
                }

                // The token is carried through from this closure, so a result
                // can only ever be attributed to the token it was produced for.
                return { token, outcome };
            }),
        );

        if (outcomes.length !== req.tokens.length) {
            throw new PushTransportError(
                `apns fan-out produced ${outcomes.length} results for ${req.tokens.length} tokens`,
                'transient',
            );
        }

        if (outcomes.length > 0 && outcomes.every((o) => o.outcome.timedOut === true)) {
            log.warn('apns call timed out before any token was answered', {
                tokens: outcomes.length,
                sendTimeoutMs: this.#sendTimeoutMs,
            });
            // No token in the message: push-outbox.ts logs errMsg(err) verbatim.
            throw new PushTransportError('apns request timed out', 'transient');
        }

        return outcomes.map(({ token, outcome }) => ({ token, status: outcome.status }));
    }

    /** Releases the kept-alive HTTP/2 connections. */
    async close(): Promise<void> {
        const dispatchers = [...this.#dispatchers.values()];
        this.#dispatchers.clear();
        await Promise.all(dispatchers.map((d) => d.close()));
    }

    #dispatcherFor(origin: string): Dispatcher {
        let dispatcher = this.#dispatchers.get(origin);
        if (!dispatcher) {
            dispatcher = this.#factory(origin);
            this.#dispatchers.set(origin, dispatcher);
        }
        return dispatcher;
    }

    async #sendOne(args: {
        token: string;
        dispatcher: Dispatcher;
        headers: Record<string, string>;
        body: Buffer;
        deadline: AbortSignal;
        allowRemint: boolean;
    }): Promise<AttemptOutcome> {
        const { token, dispatcher, headers, body, deadline, allowRemint } = args;

        let jwt: string;
        try {
            jwt = await this.#tokenStore.get();
        } catch (err) {
            // No signing token means no request can be made at all. The
            // credential was validated at load, so reaching here is a runtime
            // fault rather than a configuration one — `failed`, which takes the
            // ladder, not `invalid`, which discards the notification.
            log.error('could not mint provider token', {
                err: err instanceof Error ? err.message : String(err),
            });
            return { status: 'failed' };
        }

        // Whichever of the per-token timeout and the whole-call budget fires
        // first. Without the shared budget, N slow tokens would each wait the
        // full per-token timeout and overrun the outbox's claim window.
        const signal = AbortSignal.any([deadline, AbortSignal.timeout(this.#requestTimeoutMs)]);

        let response: Dispatcher.ResponseData;
        try {
            response = await dispatcher.request({
                method: 'POST',
                path: `/3/device/${token}`,
                headers: { ...headers, authorization: `bearer ${jwt}` },
                body,
                signal,
                // 🔴 Without this, undici runs the fan-out *serially*.
                //
                // `client-h2.js`'s `busy()` returns true for any request with
                // `idempotent === false` while another is in flight, and undici
                // derives idempotency from the method — so every POST waits for
                // the previous one's response even though HTTP/2 could carry
                // them as concurrent streams. Measured: four tokens went
                // 4/307/308/309 ms to 7/7/7/7 ms with this set. 50 tokens at a
                // 60 ms round trip would take 3 s serialised, blowing the
                // whole-call budget above, and the only symptom would be
                // "push is slow".
                //
                // Marking it idempotent is honest as well as necessary: every
                // send carries `apns-collapse-id`, so a duplicate delivery
                // coalesces on the device. It enables no automatic retry —
                // undici consults `idempotent` only in this gate.
                idempotent: true,
            });
        } catch (err) {
            // Network error, connection reset, or a deadline firing. All
            // retryable; `timedOut` distinguishes the deadline so `send()` can
            // report a wholly-timed-out call as one transient failure.
            log.debug('apns request failed before a response', {
                token: tokenPreview(token),
                err: err instanceof Error ? err.message : String(err),
            });
            return { status: 'failed', timedOut: deadline.aborted || isAbortError(err) };
        }

        const statusCode = response.statusCode;
        const apnsId = headerValue(response.headers['apns-id']);

        let rawBody = '';
        try {
            // The stream must be consumed either way, or the HTTP/2 stream and
            // its flow-control window are never released.
            if (statusCode === 200) {
                await response.body.dump();
            } else {
                rawBody = await response.body.text();
            }
        } catch (err) {
            log.debug('could not read apns response body', {
                token: tokenPreview(token),
                statusCode,
                err: err instanceof Error ? err.message : String(err),
            });
        }

        const reason = parseApnsReason(rawBody);
        const outcome = mapApnsResponse(statusCode, reason);

        if (outcome.kind === 'remint-and-retry') {
            if (!allowRemint) {
                log.warn('ExpiredProviderToken persisted after a re-mint', {
                    token: tokenPreview(token),
                    hint: 'A freshly minted token being rejected points at server clock skew or a revoked key, not at expiry.',
                });
                return {
                    status: 'failed',
                    ...(reason ? { reason } : {}),
                    statusCode,
                    ...(apnsId ? { apnsId } : {}),
                };
            }

            try {
                // Compare-and-swap inside the store: a fan-out of N tokens
                // hitting the same expired JWT produces one re-mint, not N.
                await this.#tokenStore.refresh(jwt);
            } catch (err) {
                log.error('provider-token re-mint failed', {
                    err: err instanceof Error ? err.message : String(err),
                });
                return { status: 'failed', ...(reason ? { reason } : {}), statusCode };
            }

            return this.#sendOne({ ...args, allowRemint: false });
        }

        return {
            status: outcome.status,
            ...(reason ? { reason } : {}),
            statusCode,
            ...(apnsId ? { apnsId } : {}),
        };
    }
}

/**
 * Headers shared by every token in a fan-out. `authorization` is added
 * per-request because a re-mint mid-fan-out must not be shadowed by a stale
 * value baked in here.
 */
function baseHeaders(req: PushRequest): Record<string, string> {
    return {
        'apns-topic': req.bundleId,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        // Absolute epoch seconds, passed through byte-for-byte. Recomputing it
        // as `now + something` would make the deadline a property of the
        // delivery queue rather than of the notification.
        'apns-expiration': String(req.expirationEpochSeconds),
        'apns-collapse-id': req.collapseId,
    };
}

function headerValue(value: string | string[] | undefined): string | undefined {
    if (Array.isArray(value)) return value[0];
    return value;
}

function isAbortError(err: unknown): boolean {
    if (typeof err !== 'object' || err === null) return false;
    const name = (err as { name?: unknown }).name;
    const code = (err as { code?: unknown }).code;
    return (
        name === 'AbortError' ||
        name === 'TimeoutError' ||
        code === 'UND_ERR_ABORTED' ||
        code === 'UND_ERR_HEADERS_TIMEOUT' ||
        code === 'UND_ERR_BODY_TIMEOUT'
    );
}
