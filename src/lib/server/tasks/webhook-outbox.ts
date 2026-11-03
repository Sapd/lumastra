// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// WebhookOutbox — HMAC-signed HTTP delivery worker.
//
// Enqueues CloudEvents to task_webhook_outbox for all matching hook
// subscriptions, then delivers them with exponential backoff.
// Signing: X-Lumastra-Signature: t=<unix>,v1=<hex>  (Stripe convention).
// Backoff: 1s, 5s, 30s, 5min, 30min, 2h, 12h, 24h → dead=true.
//
// Hook cache is populated from task_webhook_hooks on first enqueue and
// invalidated via pubsub on admin writes.
//
// TWO owner tables share this one delivery worker (migration 16.192.0):
//   task_webhook_hooks          — operator-owned, filter-driven, fanned out by
//                                 enqueue() to every hook whose filters match.
//   user_notification_webhooks  — user-owned, one row per user, addressed
//                                 directly (never fanned out); rows are queued
//                                 by user-webhook-notifier.service.ts.
// The hook CACHE and enqueue()/matchesHook() below are the OPERATOR path only —
// they read task_webhook_hooks and nothing else, which is why a per-user hook
// can never receive an operator event or another user's notification. Only
// deliveryPass() sees both, and only because signing/backoff/DLQ are identical.

import { createRepeatWarning } from '$lib/server/utils/repeat-warning.js';
import type postgres from 'postgres';
import {
    LUMASTRA_WEBHOOK_RETRY_ATTEMPTS,
    LUMASTRA_WEBHOOK_DELIVERY_CONCURRENCY,
    config,
} from '$lib/server/config.js';
import { decrypt, encrypt, deriveMasterKey, type StoreRotationResult } from './secrets.js';
import { isAadBoundBlob } from '$lib/server/crypto/secret-box.js';
import { resolveMasterKey } from '$lib/server/crypto/master-key.js';
import { signatureHeader, sanitizeWebhookHeaders } from './webhook-signature.js';
import {
    assertPublicHttpUrl,
    assertWebhookTargetUrl,
    safeFetch,
    UrlSafetyError,
} from './url-safety.js';
import type { CloudEvent } from './cloud-events.js';
import { Logger } from '$lib/server/utils/logger.js';
import { webhookDeliveriesTotal } from './metrics.js';
import { subscribeToChannel } from '$lib/server/cache/valkey.js';
import { readBoundedResponseText } from '$lib/server/utils/bounded-response.js';
import { awaitInFlightTick, LOOP_STOP_TIMEOUT_MS } from './loop-stop.js';

/** A receiver's error page is only kept to 512 chars; never read more than this. */
const MAX_ERROR_BODY_BYTES = 8 * 1024;

/** Pubsub channel used to invalidate hook caches across replicas. */
export const WEBHOOK_HOOKS_INVALIDATE_CHANNEL = 'task:webhook-hooks:invalidate';

const log = Logger.for('WebhookOutbox');
const passFailures = createRepeatWarning(log);

// ── Constants ─────────────────────────────────────────────────────────────────

/** Backoff schedule in seconds: 1s, 5s, 30s, 5min, 30min, 2h, 12h, 24h */
const BACKOFF_SECONDS = [1, 5, 30, 300, 1800, 7200, 43200, 86400] as const;

const DELIVERY_INTERVAL_MS = 1_000;

/**
 * Belt-and-braces hook-cache TTL. Even when pubsub invalidation works
 * across all replicas, falling back to a hard expiry guarantees that
 * config drift heals itself within at most this window.
 */
const HOOKS_CACHE_TTL_MS = 60_000;

/**
 * Marker prefix on `task_webhook_outbox.last_error` for rows this worker
 * RETIRED administratively rather than failed to deliver.
 *
 * Both kinds of row end up `dead = true`, because `dead` is what takes a row
 * out of the pending set and what hands it to `pruneDeliveredWebhookOutbox`
 * (which only ever deletes `delivered_at IS NOT NULL OR dead = true` — a row
 * that is merely unclaimable is never pruned and leaks forever). But they mean
 * opposite things to an operator: a delivery failure is a fault to chase, a
 * retirement is the system correctly declining to send. `component-health.ts`
 * splits its `dead` count on this prefix so a routine user-disable does not
 * park a "Webhook delivery degraded" warning in the admin attention panel for
 * the full 30-day retention window.
 *
 * Matched with SQL `LIKE ${prefix}%`; keep it free of `%` and `_` so it needs
 * no escaping, and treat it as a wire contract — changing it strands already-
 * retired rows on the delivery-failure side of the probe until they prune out.
 */
export const OUTBOX_RETIRED_ERROR_PREFIX = '[retired] ';

/** Feature flag turned off under rows that were already queued. */
const RETIRED_FEATURE_DISABLED = `${OUTBOX_RETIRED_ERROR_PREFIX}per-user notification webhooks are disabled by the administrator`;

/** Owning user account disabled or deleted after the row was queued. */
const RETIRED_OWNER_INACTIVE = `${OUTBOX_RETIRED_ERROR_PREFIX}the owning user account is disabled or deleted`;

/** A forwarded notification whose recipient opted out, or whose account went away, after it was queued. */
const RETIRED_FORWARDING_REVOKED = `${OUTBOX_RETIRED_ERROR_PREFIX}the user turned notification forwarding off or the account is disabled or deleted`;

/**
 * The CloudEvent type of a user's notification forwarded to an operator hook
 * (`notification-forwarder.service.ts`). Kept as a literal here rather than
 * imported: this worker must not depend on the notification stack.
 */
const FORWARDED_NOTIFICATION_TYPE = 'org.lumastra.user.notification';

/**
 * Per-pass ceiling on the owner-inactive retirement sweep. The sweep reads the
 * same `idx_outbox_pending` range the claim query already walks
 * (`delivered_at IS NULL AND dead = false AND next_attempt_at <= NOW()`), so on
 * a healthy outbox it touches an empty or tiny range every tick; the cap only
 * bounds the one-off catch-up when a backlog of pre-existing rows is retired
 * for the first time.
 */
const RETIRE_SWEEP_LIMIT = 200;

// ── Hook cache entry ──────────────────────────────────────────────────────────

interface CachedHook {
    id: string;
    url: string;
    secretEncrypted: Buffer;
    eventFilter: string[];
    taskFilter: string[] | null;
    libraryGroupFilter: string[] | null;
    mediaTypeFilter: string[] | null;
    headers: Record<string, string> | null;
    active: boolean;
    includeProgress: boolean;
}

// ── Outbox row shape from DB ──────────────────────────────────────────────────

/**
 * A claimed outbox row, already resolved against whichever owner table holds
 * its endpoint.
 *
 * `hook_id` and `user_hook_id` are mutually exclusive — the
 * `task_webhook_outbox_one_owner` CHECK (migration 16.192.0) guarantees exactly
 * one is set. `url` / `secret_encrypted` are COALESCEd across the two owner
 * tables in the claim query, so everything below this point is owner-agnostic:
 * signing, backoff, the 404/410 fast-death and the DLQ are literally the same
 * code for an operator hook and a user hook.
 *
 * `headers` is operator-only by design. A user hook has no custom-header field
 * (see `user_notification_webhooks`), because a header is an arbitrary
 * user-controlled string sent to a user-controlled host — an `Authorization`
 * smuggling surface with no product need behind it.
 */
interface OutboxRow {
    id: string;
    hook_id: string | null;
    user_hook_id: string | null;
    /**
     * `user_notification_webhooks.user_id` for a user-owned row, NULL for an
     * operator one. The per-user table's secret is sealed bound to its USER,
     * not its row id: the row is upserted per user (UNIQUE user_id) and its id
     * survives a save, but only the user_id is knowable before the first INSERT
     * returns. See `webhookSecretContext`.
     */
    owner_user_id: string | null;
    event_id: string;
    payload: CloudEvent;
    attempts: number;
    url: string;
    secret_encrypted: Buffer;
    headers: Record<string, string> | null;
}

/**
 * `users.id` of a forwarded notification's recipient, read from the payload
 * (`data.user.id`), or NULL for any other row.
 *
 * A CASE so the uuid cast only ever sees a forwarded row with a UUID-shaped
 * id: operator payloads are arbitrary CloudEvents and Postgres does not promise
 * to evaluate the type test before a cast placed beside it in an ON clause.
 */
function forwardRecipientIdSql(sql: postgres.Sql): postgres.PendingQuery<postgres.Row[]> {
    return sql`(
        CASE
            WHEN o.hook_id IS NOT NULL
             AND o.payload->>'type' = ${FORWARDED_NOTIFICATION_TYPE}
             AND o.payload->'data'->'user'->>'id'
                 ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN (o.payload->'data'->'user'->>'id')::uuid
        END
    )`;
}

/**
 * Is this row owned by a per-user hook?
 *
 * Tested on `hook_id` rather than on `user_hook_id`, and NOT with a bare
 * `!== null`. The one-owner CHECK makes the two questions equivalent in the
 * database, but a row that reached here from anywhere other than a full
 * `SELECT` (a fixture, a partial projection) can carry `undefined` rather than
 * `null` — and `undefined !== null` is true, which would silently classify every
 * operator row as user-owned and hand it to the disabled-feature retirement path
 * below. Absence, in either spelling, means "operator".
 */
function isUserOwned(row: OutboxRow): boolean {
    return row.hook_id === null || row.hook_id === undefined;
}

/**
 * AAD context binding a webhook signing secret to the row that owns it
 * (security review 2026-09-13, C19). Naming the TABLE as well as the id stops a
 * secret being moved between the operator and the per-user store.
 */
function webhookSecretContext(row: OutboxRow): string {
    return isUserOwned(row)
        ? userWebhookSecretContext(row.owner_user_id ?? 'unknown')
        : operatorWebhookSecretContext(row.hook_id ?? 'unknown');
}

/** AAD context for a `task_webhook_hooks` row, keyed by hook id. */
export function operatorWebhookSecretContext(hookId: string): string {
    return `task_webhook_hooks:${hookId.toLowerCase()}`;
}

/**
 * AAD context for a `user_notification_webhooks` row, keyed by its OWNER.
 *
 * One row per user (UNIQUE user_id), and "save" is an upsert that keeps the
 * existing row id — so the user id is the identity that is both stable for the
 * life of the row and known before the first INSERT has returned one.
 */
export function userWebhookSecretContext(userId: string): string {
    return `user_notification_webhooks:${userId.toLowerCase()}`;
}

/** Log-friendly owner label for a claimed row. */
function ownerOf(row: OutboxRow): string {
    return isUserOwned(row) ? `user:${row.user_hook_id ?? 'unknown'}` : (row.hook_id ?? 'unknown');
}

// ── Progress event check ──────────────────────────────────────────────────────

const PROGRESS_EVENT_TYPES = new Set(['org.lumastra.task.run.stage.completed']);

function isProgressEvent(eventType: string): boolean {
    return PROGRESS_EVENT_TYPES.has(eventType);
}

// ── Backoff helper ────────────────────────────────────────────────────────────

function backoffSeconds(attempts: number): number {
    const idx = Math.min(attempts, BACKOFF_SECONDS.length - 1);
    return BACKOFF_SECONDS[idx];
}

// ── WebhookOutbox ─────────────────────────────────────────────────────────────

export class WebhookOutbox {
    private timer: ReturnType<typeof setInterval> | null = null;
    /** The delivery pass currently running, if any. stop() waits for it. */
    private inFlight: Promise<void> | null = null;
    private stopped = false;

    /** In-memory hook cache. Null means not yet loaded. */
    private hooks: CachedHook[] | null = null;
    /** When the hook cache was populated (epoch ms). Used for TTL fallback. */
    private hooksLoadedAt = 0;
    /** Unsubscribe handle for the cross-replica invalidation channel. */
    private invalidationUnsub: (() => Promise<void>) | null = null;
    private invalidationStarted = false;

    constructor(private readonly sql: postgres.Sql) {}

    // -- Hook cache -----------------------------------------------------------

    private async loadHooks(): Promise<CachedHook[]> {
        const rows = await this.sql<
            {
                id: string;
                url: string;
                secret_encrypted: Buffer;
                event_filter: unknown;
                task_filter: unknown;
                library_group_filter: unknown;
                media_type_filter: unknown;
                headers: unknown;
                active: boolean;
                include_progress: boolean;
            }[]
        >`
            SELECT id, url, secret_encrypted, event_filter,
                   task_filter, library_group_filter, media_type_filter, headers,
                   active, include_progress
            FROM task_webhook_hooks
            WHERE active = true
        `;
        return rows.map((r) => ({
            id: r.id,
            url: r.url,
            secretEncrypted: r.secret_encrypted,
            eventFilter: asStringArray(r.event_filter),
            taskFilter: r.task_filter ? asStringArray(r.task_filter) : null,
            libraryGroupFilter: r.library_group_filter
                ? asStringArray(r.library_group_filter)
                : null,
            mediaTypeFilter: r.media_type_filter ? asStringArray(r.media_type_filter) : null,
            headers: asStringRecord(r.headers),
            active: r.active,
            includeProgress: r.include_progress,
        }));
    }

    private async getHooks(): Promise<CachedHook[]> {
        const expired = this.hooks !== null && Date.now() - this.hooksLoadedAt > HOOKS_CACHE_TTL_MS;
        if (this.hooks === null || expired) {
            this.hooks = await this.loadHooks();
            this.hooksLoadedAt = Date.now();
        }
        return this.hooks;
    }

    /**
     * Invalidate hook cache. Call when admin creates/updates/deletes a hook
     * so the next enqueue() picks up fresh data.
     */
    invalidateCache(): void {
        this.hooks = null;
        this.hooksLoadedAt = 0;
    }

    // -- Filter logic ---------------------------------------------------------

    private matchesHook(event: CloudEvent, hook: CachedHook): boolean {
        // Event type filter.
        if (hook.eventFilter.length > 0 && !hook.eventFilter.includes(event.type)) {
            return false;
        }
        // Progress opt-in.
        if (isProgressEvent(event.type) && !hook.includeProgress) {
            return false;
        }
        // Task filter: subject is `${taskId}/${runId}`.
        if (hook.taskFilter && hook.taskFilter.length > 0) {
            const taskId = event.subject.split('/')[0] ?? '';
            if (!hook.taskFilter.includes(taskId)) return false;
        }
        // Library group filter: embedded in event data if present.
        if (hook.libraryGroupFilter && hook.libraryGroupFilter.length > 0) {
            const data = event.data as Record<string, unknown> | undefined;
            const scope = data?.scope as Record<string, unknown> | undefined;
            const lgId = scope?.libraryGroupId as string | undefined;
            if (!lgId || !hook.libraryGroupFilter.includes(lgId)) return false;
        }
        // Media-type filter (media.item.added events). The single-item match
        // path reads data.mediaType; batched delivery bypasses matchesHook via
        // enqueueToHook, so this only guards the rare direct-enqueue path.
        if (hook.mediaTypeFilter && hook.mediaTypeFilter.length > 0) {
            const data = event.data as { mediaType?: string } | undefined;
            const mt = data?.mediaType;
            if (mt !== undefined && !hook.mediaTypeFilter.includes(mt)) return false;
        }
        return true;
    }

    // -- Enqueue --------------------------------------------------------------

    /**
     * Enqueue an event for delivery to all matching hooks.
     */
    async enqueue(event: CloudEvent): Promise<void> {
        // Plugin fan-out. Deliberately BEFORE the hook lookup and independent
        // of it: a subscribing integration must receive task events whether or
        // not an operator happens to have configured a webhook. Fire-and-forget
        // — the publisher never rejects, and the outbox INSERTs must not wait
        // on a third-party handler.
        //
        // Imported LAZILY on purpose. The publisher reaches the task registry
        // and the plugin-context builder; importing it at module scope would
        // drag that whole graph into every consumer of the outbox, which is a
        // low-level delivery worker that should depend on nothing above it.
        // The import is resolved once and cached by the module loader.
        void import('$lib/server/plugins/runtime/integration-events.js')
            .then((m) => m.publishIntegrationEvent({ type: event.type, payload: event.data }))
            .catch((err) => {
                log.warn('WebhookOutbox.enqueue: plugin fan-out failed', { err: errMsg(err) });
            });

        let hooks: CachedHook[];
        try {
            hooks = await this.getHooks();
        } catch (err) {
            log.warn('WebhookOutbox.enqueue: failed to load hooks', {
                err: errMsg(err),
            });
            return;
        }

        const now = new Date();
        for (const hook of hooks) {
            if (!this.matchesHook(event, hook)) continue;
            try {
                await this.sql`
                    INSERT INTO task_webhook_outbox (hook_id, event_id, payload, next_attempt_at)
                    VALUES (
                        ${hook.id}::uuid,
                        ${event.id},
                        ${this.sql.json(event as unknown as Record<string, never>)},
                        ${now}
                    )
                    ON CONFLICT (hook_id, event_id) DO NOTHING
                `;
            } catch (err) {
                log.warn('WebhookOutbox.enqueue: INSERT failed', {
                    hookId: hook.id,
                    eventId: event.id,
                    err: errMsg(err),
                });
            }
        }
    }

    /**
     * Enqueue an event directly to one specific hook, bypassing matchesHook.
     * Used for batched media.item.added delivery, where the matching decision
     * was already made at staging time (per-hook fan-out). Inherits the same
     * HMAC signing / retry / DLQ as enqueue().
     *
     * Pass `executor` to run the INSERT inside an existing transaction so the
     * outbox INSERT and the caller's pending DELETE are atomic. Without it the
     * INSERT commits on this.sql and a crash between the two leaves a duplicate.
     */
    async enqueueToHook(hookId: string, event: CloudEvent, executor?: postgres.Sql): Promise<void> {
        const sql = executor ?? this.sql;
        const insert = (): Promise<unknown> => sql`
            INSERT INTO task_webhook_outbox (hook_id, event_id, payload, next_attempt_at)
            VALUES (
                ${hookId}::uuid,
                ${event.id},
                ${sql.json(event as unknown as Record<string, never>)},
                ${new Date()}
            )
            ON CONFLICT (hook_id, event_id) DO NOTHING
        `;
        if (executor) {
            // Transactional caller (batched flush): let errors propagate so the
            // surrounding tx rolls back and the pending rows are NOT deleted.
            await insert();
            return;
        }
        try {
            await insert();
        } catch (err) {
            log.warn('WebhookOutbox.enqueueToHook: INSERT failed', {
                hookId,
                eventId: event.id,
                err: errMsg(err),
            });
        }
    }

    // -- Background delivery worker -------------------------------------------

    start(options: { deliver?: boolean } = {}): void {
        if (this.stopped) return;
        if (options.deliver !== false && this.timer === null) {
            this.timer = setInterval(() => void this.tick(), DELIVERY_INTERVAL_MS);
            this.timer.unref?.();
        }
        // Web producers need live hook filters even though only workers drain
        // durable delivery rows. Subscription and delivery have separate lives.
        if (!this.invalidationStarted) {
            this.invalidationStarted = true;
            void this.subscribeInvalidation();
        }
    }

    /**
     * Pause delivery (coordinator lost) and wait (bounded) for the pass in
     * flight. Unlike stop(), a later start() resumes delivery and the hook
     * invalidation subscription stays.
     */
    stopDelivery(timeoutMs: number = LOOP_STOP_TIMEOUT_MS): Promise<boolean> {
        if (this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
        }
        return awaitInFlightTick('webhook-outbox', this.inFlight, timeoutMs);
    }

    /**
     * Stop delivering and wait (bounded) for the pass in flight. Resolves true
     * once no pass is running, false if the wait timed out. A pass that is still
     * posting when the process exits leaves its claimed rows to be redelivered
     * after the claim window, so shutdown waits for it instead.
     */
    stop(timeoutMs: number = LOOP_STOP_TIMEOUT_MS): Promise<boolean> {
        this.stopped = true;
        if (this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
        }
        if (this.invalidationUnsub) {
            const unsub = this.invalidationUnsub;
            this.invalidationUnsub = null;
            void unsub().catch(() => {});
        }
        return awaitInFlightTick('webhook-outbox', this.inFlight, timeoutMs);
    }

    private async subscribeInvalidation(): Promise<void> {
        try {
            const unsub = await subscribeToChannel(WEBHOOK_HOOKS_INVALIDATE_CHANNEL, () =>
                this.invalidateCache(),
            );
            if (this.stopped) await unsub?.();
            else if (unsub) this.invalidationUnsub = unsub;
        } catch (err) {
            this.invalidationStarted = false;
            log.warn('WebhookOutbox: invalidation subscribe failed', {
                err: errMsg(err),
            });
        }
    }

    private tick(): Promise<void> {
        if (this.stopped || this.inFlight) return Promise.resolve();
        this.inFlight = this.deliveryPass()
            .then(
                () => passFailures.reset(),
                (err: unknown) => {
                    // Every second while PostgreSQL is down: one warning per window.
                    passFailures.warn('WebhookOutbox delivery pass error', { err: errMsg(err) });
                },
            )
            .finally(() => {
                this.inFlight = null;
            });
        return this.inFlight;
    }

    // -- Delivery pass --------------------------------------------------------

    /**
     * One delivery pass: read ready rows, deliver in parallel, update status.
     *
     * Cross-replica claim model: rows are claimed inside a short transaction
     * via `SELECT … FOR UPDATE SKIP LOCKED`. Inside the same transaction we
     * push `next_attempt_at` forward by CLAIM_TTL_SECONDS so the row falls
     * out of the "ready" set for every other replica's next tick. The HTTP
     * delivery happens AFTER the transaction commits — we don't hold a PG
     * row lock across a network call.
     *
     * Why a claim window vs holding the row lock: HTTP delivery can take
     * up to the 30s fetch timeout. Holding a Postgres row lock for that
     * long would back up every other reader and inflate connection-pool
     * usage. The "bump next_attempt_at forward" pattern gets us the same
     * cross-replica mutual exclusion at the row level without holding
     * locks across IO.
     *
     * Residual at-least-once risk: if HTTP delivery exceeds the claim TTL
     * (5 min), another replica may pick the row up and re-deliver. The
     * 30s fetch timeout × 10x margin makes this very rare; the HMAC +
     * event_id let consumers dedupe if it ever happens.
     */
    async deliveryPass(): Promise<{
        delivered: number;
        failed: number;
        remaining: number;
    }> {
        const limit = LUMASTRA_WEBHOOK_DELIVERY_CONCURRENCY;
        const maxAttempts = LUMASTRA_WEBHOOK_RETRY_ATTEMPTS;
        // 5 minutes — covers the 30s fetch timeout with order-of-magnitude
        // margin for GC pauses / cold connections / DNS slowness. Crashed
        // workers' claims auto-release at TTL.
        const CLAIM_TTL_SECONDS = 300;

        const claimed = await this.sql.begin(async (txRaw) => {
            const tx = txRaw as unknown as postgres.Sql;
            // Two owner tables, one delivery path. The join is LEFT on both
            // because exactly one side matches per row (enforced by the
            // one-owner CHECK); the WHERE then requires that the matching side
            // actually resolved, which reproduces the old INNER JOIN's
            // behaviour for operator rows (a hook that is inactive or gone
            // yields no delivery) without needing a second query.
            //
            // SECURITY (C8, security review 2026-09-17): a THIRD left join,
            // onto `users` via `u.user_id`, re-checks the per-user row's
            // owner on every claim. Before this, an admin disabling a user
            // (`revokeAllCredentialsForUser`, which never reaches
            // `user_notification_webhooks`) left that user's already-queued
            // rows claimable and deliverable forever: the disabled user kept
            // receiving their event stream at a destination they control.
            // THIS JOIN IS THE ONLY CONTROL on this axis — review round 1,
            // Minor 4 corrected an earlier version of this comment that
            // wrongly claimed `enqueueUserWebhookDelivery` (`user-
            // notification-webhooks.queries.ts`) had its own disabled/deleted
            // gate. It does not: it is a bare `INSERT ... ON CONFLICT DO
            // NOTHING`, and its only caller (`user-webhook-notifier.service.ts`'s
            // `enqueueUserNotificationWebhook`) has no lifecycle check either. Do not relax
            // or remove this join on the assumption that enqueue-time
            // filtering exists elsewhere — it does not. `usr` is only ever
            // NULL for an operator-owned row (u.id IS NULL, so nothing to
            // join) or a per-user row whose owner was hard-deleted — both
            // cases must still be excluded from delivery, hence
            // `usr.id IS NOT NULL` rather than allowing a NULL join to pass
            // through.
            //
            // The owner-inactive retirement sweep further down negates this
            // exact three-part test to mark the rows it locks out. If you
            // change the test here, change it there too — they are one
            // predicate expressed twice, and a drift leaves rows either
            // deliverable-and-retired or neither.
            //
            // `FOR UPDATE OF o` is still legal here: only `o` is locked, and `o`
            // is the non-nullable side of every outer join.
            const claimed = await tx<OutboxRow[]>`
                SELECT o.id, o.hook_id, o.user_hook_id, o.event_id,
                       o.payload, o.attempts,
                       COALESCE(h.url, u.url) AS url,
                       COALESCE(h.secret_encrypted, u.secret_encrypted) AS secret_encrypted,
                       u.user_id::text AS owner_user_id,
                       h.headers
                FROM task_webhook_outbox o
                LEFT JOIN task_webhook_hooks h
                       ON h.id = o.hook_id AND h.active = true
                LEFT JOIN user_notification_webhooks u
                       ON u.id = o.user_hook_id
                LEFT JOIN users usr
                       ON usr.id = u.user_id
                LEFT JOIN users fwd
                       ON fwd.id = ${forwardRecipientIdSql(tx)}
                WHERE o.delivered_at IS NULL
                  AND o.dead = false
                  AND o.next_attempt_at <= NOW()
                  AND (h.id IS NOT NULL OR u.id IS NOT NULL)
                  AND (
                      u.id IS NULL
                      OR (usr.id IS NOT NULL AND usr.disabled_at IS NULL AND usr.deleted_at IS NULL)
                  )
                  -- A forwarded notification is the RECIPIENT's data, consented
                  -- per user: re-check that consent and the account on every
                  -- claim, so opting out or a disable stops what is already
                  -- queued (same reasoning as the C8 owner join above).
                  AND (
                      o.payload->>'type' IS DISTINCT FROM ${FORWARDED_NOTIFICATION_TYPE}
                      OR o.hook_id IS NULL
                      OR (
                          fwd.id IS NOT NULL
                          AND fwd.notification_forwarding = true
                          AND fwd.disabled_at IS NULL
                          AND fwd.deleted_at IS NULL
                      )
                  )
                ORDER BY o.next_attempt_at
                LIMIT ${limit}
                FOR UPDATE OF o SKIP LOCKED
            `;
            if (claimed.length > 0) {
                const ids = claimed.map((r) => r.id);
                await tx`
                    UPDATE task_webhook_outbox
                    SET next_attempt_at = NOW() + (${CLAIM_TTL_SECONDS} * INTERVAL '1 second')
                    WHERE id = ANY(${ids}::uuid[])
                `;
            }
            return claimed;
        });

        // Retire rows the C8 join permanently locked out.
        //
        // The claim query above excludes a per-user row whose owner is
        // disabled/deleted, and that join is the security control — it fails
        // closed for rows queued BEFORE the disable, which is exactly why C8
        // was fixed there rather than in `revokeAllCredentialsForUser`. But
        // "never claimable" is not "finished": nothing marks those rows, so
        // they sit pending forever (`pruneDeliveredWebhookOutbox` only deletes
        // delivered-or-dead rows), and if the account is ever re-enabled they
        // become claimable again with a long-stale `next_attempt_at` and
        // deliver a notification from weeks ago.
        //
        // This sweep is deliberately a SEPARATE statement rather than a
        // relaxation of the claim query: folding the owner check into the
        // claim and filtering post-claim (the shape the feature-flag gate
        // below uses) would make delivery depend on JS running after the row
        // was already claimed, re-opening C8 on any early return or crash
        // between the two. The claim stays fail-closed; this only tidies up
        // behind it, so it is safe for it to be best-effort.
        //
        // The predicate is the EXACT negation of the claim query's owner test
        // — keep the two in lockstep, or rows will be claimable and retired at
        // the same time (or neither). `usr.id IS NULL` (owner hard-deleted out
        // from under the hook) must retire too, which is why this is a NOT over
        // the positive form rather than a naive `disabled_at IS NOT NULL OR
        // deleted_at IS NOT NULL`. Orphaned hook rows need no handling here:
        // `task_webhook_outbox_user_hook_id_fkey` is ON DELETE CASCADE, so a
        // deleted hook takes its outbox rows with it.
        try {
            const retired = await this.sql`
                UPDATE task_webhook_outbox
                SET dead = true,
                    last_error = ${RETIRED_OWNER_INACTIVE}
                WHERE id IN (
                    SELECT o.id
                    FROM task_webhook_outbox o
                    JOIN user_notification_webhooks u ON u.id = o.user_hook_id
                    LEFT JOIN users usr ON usr.id = u.user_id
                    WHERE o.delivered_at IS NULL
                      AND o.dead = false
                      AND o.next_attempt_at <= NOW()
                      AND NOT (
                          usr.id IS NOT NULL
                          AND usr.disabled_at IS NULL
                          AND usr.deleted_at IS NULL
                      )
                    LIMIT ${RETIRE_SWEEP_LIMIT}
                    FOR UPDATE OF o SKIP LOCKED
                )
            `;
            if (retired.count > 0) {
                log.info('WebhookOutbox: retired queued rows for disabled/deleted users', {
                    count: retired.count,
                });
            }
        } catch (err) {
            // Best-effort by design: the claim query already refuses to
            // deliver these rows, so a failed sweep costs disk, not safety.
            log.warn('WebhookOutbox: failed to retire owner-inactive rows', {
                err: errMsg(err),
            });
        }

        // Retire forwarded notifications the claim query now refuses — the exact
        // negation of its forwarding predicate, for the same reason as the sweep
        // above (a re-enabled flag must not release weeks-old notifications).
        try {
            const retired = await this.sql`
                UPDATE task_webhook_outbox
                SET dead = true,
                    last_error = ${RETIRED_FORWARDING_REVOKED}
                WHERE id IN (
                    SELECT o.id
                    FROM task_webhook_outbox o
                    LEFT JOIN users fwd ON fwd.id = ${forwardRecipientIdSql(this.sql)}
                    WHERE o.delivered_at IS NULL
                      AND o.dead = false
                      AND o.next_attempt_at <= NOW()
                      AND o.hook_id IS NOT NULL
                      AND o.payload->>'type' = ${FORWARDED_NOTIFICATION_TYPE}
                      AND NOT (
                          fwd.id IS NOT NULL
                          AND fwd.notification_forwarding = true
                          AND fwd.disabled_at IS NULL
                          AND fwd.deleted_at IS NULL
                      )
                    LIMIT ${RETIRE_SWEEP_LIMIT}
                    FOR UPDATE OF o SKIP LOCKED
                )
            `;
            if (retired.count > 0) {
                log.info('WebhookOutbox: retired forwarded notifications after opt-out/disable', {
                    count: retired.count,
                });
            }
        } catch (err) {
            log.warn('WebhookOutbox: failed to retire revoked forwarded notifications', {
                err: errMsg(err),
            });
        }

        // The admin gate, second half.
        //
        // `enqueueUserNotificationWebhook` refuses to create a row while the
        // feature is off, which covers everything queued AFTER the operator
        // flips it. This covers what was already queued BEFORE: without it, a
        // flip-to-off leaves up to 24 hours of retries still going out to the
        // very endpoints the operator just decided this server should not be
        // talking to — the opposite of what turning a switch off means.
        //
        // Marked dead rather than silently skipped, so the rows leave the
        // pending set (they would otherwise be re-claimed every tick forever)
        // and the stored `last_error` says why they stopped. Carries the
        // OUTBOX_RETIRED_ERROR_PREFIX marker for the same reason the sweep
        // above does: this is the operator's own switch taking effect, not a
        // delivery fault, and it must not read as one in component health.
        // Annotated: `claimed` is postgres.js's RowList (an Array subtype that
        // also carries .count/.command/...), so inferring from it would type
        // `rows` as RowList and reject the plain array `.filter()` returns.
        let rows: OutboxRow[] = claimed;
        if (!config.FEATURE_USER_NOTIFICATION_WEBHOOKS) {
            const disabled = claimed.filter(isUserOwned);
            if (disabled.length > 0) {
                rows = claimed.filter((r) => !isUserOwned(r));
                try {
                    await this.sql`
                        UPDATE task_webhook_outbox
                        SET dead = true,
                            last_error = ${RETIRED_FEATURE_DISABLED}
                        WHERE id = ANY(${disabled.map((r) => r.id)}::uuid[])
                    `;
                } catch (err) {
                    log.warn('WebhookOutbox: failed to retire disabled user-hook rows', {
                        count: disabled.length,
                        err: errMsg(err),
                    });
                }
            }
        }

        let delivered = 0;
        let failed = 0;

        await Promise.all(
            rows.map(async (row) => {
                const result = await this.deliver(row);
                if (result.outcome === 'success') {
                    delivered++;
                    webhookDeliveriesTotal.inc({ status: '2xx' });
                    try {
                        await this.sql`
                            UPDATE task_webhook_outbox
                            SET delivered_at = NOW(),
                                last_attempt_at = NOW(),
                                last_status = ${result.status},
                                last_error = NULL
                            WHERE id = ${row.id}::uuid
                        `;
                    } catch (err) {
                        log.warn('WebhookOutbox: failed to mark delivered', {
                            id: row.id,
                            err: errMsg(err),
                        });
                    }
                } else {
                    failed++;
                    webhookDeliveriesTotal.inc({ status: 'failed' });
                    // 4xx-permanent (404/410) means the endpoint has been
                    // deleted upstream — there is no point burning 8 retry
                    // attempts over 24 hours. Mark dead immediately so the
                    // outbox flushes and the admin UI surfaces the dead row.
                    const permanent4xx =
                        result.outcome === 'http' &&
                        (result.status === 404 || result.status === 410);
                    const newAttempts = row.attempts + 1;
                    const isDead = permanent4xx || newAttempts >= maxAttempts;
                    const nextSeconds = backoffSeconds(newAttempts);
                    try {
                        // CAS on attempts: a concurrent retry path can't both
                        // observe `row.attempts` and both increment to the
                        // same value. The WHERE clause forces ordering.
                        await this.sql`
                            UPDATE task_webhook_outbox
                            SET attempts        = ${newAttempts},
                                next_attempt_at = NOW() + (${nextSeconds} * INTERVAL '1 second'),
                                dead            = ${isDead}
                            WHERE id = ${row.id}::uuid
                              AND attempts = ${row.attempts}
                        `;
                    } catch (err) {
                        log.warn('WebhookOutbox: failed to record failure', {
                            id: row.id,
                            err: errMsg(err),
                        });
                    }
                }
            }),
        );

        // Count remaining pending rows.
        const countRows = await this.sql<{ n: string }[]>`
            SELECT COUNT(*) as n
            FROM task_webhook_outbox
            WHERE delivered_at IS NULL AND dead = false
        `;
        const remaining = parseInt(countRows[0]?.n ?? '0', 10);

        return { delivered, failed, remaining };
    }

    // -- Single delivery ------------------------------------------------------

    private async deliver(
        row: OutboxRow,
    ): Promise<
        | { outcome: 'success'; status: number }
        | { outcome: 'http'; status: number }
        | { outcome: 'error' }
    > {
        const timestamp = Math.floor(Date.now() / 1000);
        const body = JSON.stringify(row.payload);

        // SSRF guard: reject private/loopback/non-http(s) URLs even if the
        // hook row was created when the guard wasn't in place (e.g. migration
        // import). Failure marks the row last_error and counts as a delivery
        // failure so backoff applies and admin sees it in the outbox UI.
        // The returned URL is also the same-origin baseline for the redirect
        // policy below.
        let registeredUrl: URL;
        try {
            registeredUrl = isUserOwned(row)
                ? assertPublicHttpUrl(row.url)
                : assertWebhookTargetUrl(row.url, config.WEBHOOK_PRIVATE_HOST_ALLOWLIST);
        } catch (err) {
            const msg =
                err instanceof UrlSafetyError
                    ? `URL rejected by SSRF guard: ${err.message}`
                    : errMsg(err);
            log.warn('WebhookOutbox: SSRF guard rejected URL', {
                hookId: ownerOf(row),
                err: msg,
            });
            try {
                await this.sql`
                    UPDATE task_webhook_outbox
                    SET last_attempt_at = NOW(),
                        last_error = ${msg}
                    WHERE id = ${row.id}::uuid
                `;
            } catch {
                // Best-effort.
            }
            return { outcome: 'error' };
        }

        let secret: string;
        try {
            const masterKey = deriveMasterKey(resolveMasterKey());
            secret = decrypt(row.secret_encrypted, masterKey, webhookSecretContext(row));
        } catch (err) {
            log.warn('WebhookOutbox: failed to decrypt secret', {
                hookId: ownerOf(row),
                err: errMsg(err),
            });
            return { outcome: 'error' };
        }

        const customHeaders = row.headers ?? {};

        // 30s fetch timeout — a hung endpoint must not pin a delivery slot
        // forever; Promise.all in deliveryPass would otherwise freeze concurrency.
        const controller = new AbortController();
        const timeoutHandle = setTimeout(() => controller.abort(), 30_000);

        let response: Response;
        try {
            response = await safeFetch(
                row.url,
                {
                    method: 'POST',
                    signal: controller.signal,
                    // Operator headers spread FIRST so the X-Lumastra-* HMAC and
                    // event headers always win over any operator override.
                    headers: {
                        ...sanitizeWebhookHeaders(customHeaders),
                        'Content-Type': 'application/json',
                        'X-Lumastra-Signature': signatureHeader(timestamp, body, secret),
                        'X-Lumastra-Event': (row.payload as CloudEvent).type,
                        'X-Lumastra-Event-Id': (row.payload as CloudEvent).id,
                    },
                    body,
                },
                {
                    // Webhook deliveries carry a signed payload (HMAC + operator
                    // headers). Following a cross-origin redirect would silently
                    // exfiltrate that signed body to a host the operator never
                    // registered (domain expiry, compromise, misconfigured
                    // endpoint) while the outbox records the delivery as
                    // "delivered" to the ORIGINAL, trusted url. Same-origin
                    // path-only redirects (the common legitimate case — trailing
                    // slash, path rewrite) still pass; only scheme/host/port
                    // changes are rejected. Rejection throws UrlSafetyError,
                    // which the catch below logs (naming the redirect target)
                    // and records as a normal delivery failure — existing
                    // retry/DLQ semantics apply, no special-casing needed.
                    // Operator rows only: the operator's private-host allowlist.
                    // A per-user row never gets it (see isAllowlistedPrivateHost).
                    // validateHop below keeps every hop on the registered origin,
                    // so an allowlisted host cannot redirect to another private one.
                    ...(isUserOwned(row)
                        ? {}
                        : { allowPrivateHosts: config.WEBHOOK_PRIVATE_HOST_ALLOWLIST }),
                    validateHop: (hopUrl) => {
                        if (hopUrl.origin !== registeredUrl.origin) {
                            throw new UrlSafetyError(
                                `webhook redirect blocked: hop to cross-origin host ${hopUrl.origin} ` +
                                    `(registered origin ${registeredUrl.origin})`,
                            );
                        }
                    },
                },
            );
        } catch (err) {
            const msg = errMsg(err);
            log.warn('WebhookOutbox: fetch failed', {
                hookId: ownerOf(row),
                err: msg,
            });
            try {
                await this.sql`
                    UPDATE task_webhook_outbox
                    SET last_attempt_at = NOW(),
                        last_error = ${msg}
                    WHERE id = ${row.id}::uuid
                `;
            } catch {
                // Best-effort.
            }
            return { outcome: 'error' };
        } finally {
            clearTimeout(timeoutHandle);
        }

        if (response.ok) {
            return { outcome: 'success', status: response.status };
        }

        const status = response.status;
        let errText: string;
        try {
            errText = await readBoundedResponseText(response, MAX_ERROR_BODY_BYTES);
        } catch {
            // best-effort: unreadable error body → use the status code as the recorded error text.
            errText = `HTTP ${status}`;
        }
        try {
            await this.sql`
                UPDATE task_webhook_outbox
                SET last_attempt_at = NOW(),
                    last_status = ${status},
                    last_error  = ${errText.slice(0, 512)}
                WHERE id = ${row.id}::uuid
            `;
        } catch {
            // Best-effort.
        }
        log.warn('WebhookOutbox: non-2xx response', {
            hookId: ownerOf(row),
            status,
        });
        return { outcome: 'http', status };
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function asStringArray(value: unknown): string[] {
    if (Array.isArray(value)) return value.map(String);
    return [];
}

function asStringRecord(value: unknown): Record<string, string> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = String(v ?? '');
    }
    return out;
}

// ── Master-key rotation ───────────────────────────────────────────────────────

/**
 * Re-encrypt both webhook signing-secret columns from `oldMasterKey` to
 * `newMasterKey` (security review 2026-09-12, C9).
 *
 * TWO owner tables hold a secret (see the header comment):
 * `task_webhook_hooks.secret_encrypted` (operator hooks) and
 * `user_notification_webhooks.secret_encrypted` (per-user hooks). Both are the
 * raw `iv|tag|ciphertext` BYTEA blob this worker opens in `deliverOne()` — not
 * the `enc:v1:` string envelope — so they rotate with `decrypt`/`encrypt`.
 * Missing either one silently breaks every delivery from that table after the
 * operator swaps LUMASTRA_MASTER_KEY: the secret cannot be opened, so no
 * signature is computed and the row just errors.
 *
 * Per-row and idempotent: a blob that already opens under the NEW key and is
 * already bound to its row is counted as rotated and left alone, so re-running
 * after a partial failure finishes the job. Nothing needs a transaction for the
 * same reason. A legacy unbound blob IS rewritten even when it already opens
 * under the new key — rotation is the upgrade path to the row-bound form
 * (security review 2026-09-13, C19).
 */
export async function rotateWebhookSecrets(
    sql: postgres.Sql,
    oldMasterKey: Buffer,
    newMasterKey: Buffer,
): Promise<StoreRotationResult> {
    let rotated = 0;
    let skipped = 0;
    let legacyUpgraded = 0;
    const reasons: string[] = [];

    const tables = ['task_webhook_hooks', 'user_notification_webhooks'] as const;

    for (const table of tables) {
        const isUserTable = table === 'user_notification_webhooks';
        // Two spellings rather than one interpolated column list: only the
        // per-user table HAS a user_id, and that column is its AAD context
        // (the operator table keys on its own id). The table name in the
        // UPDATE below is a compile-time literal from the tuple above, never
        // request data — sql() is used only because postgres.js cannot
        // parameterise an identifier.
        type SecretRow = {
            id: string;
            owner_user_id: string | null;
            secret_encrypted: Buffer | null;
        };
        const rows = isUserTable
            ? await sql<SecretRow[]>`
                SELECT id::text, user_id::text AS owner_user_id, secret_encrypted
                FROM user_notification_webhooks
                WHERE secret_encrypted IS NOT NULL
            `
            : await sql<SecretRow[]>`
                SELECT id::text, NULL::text AS owner_user_id, secret_encrypted
                FROM task_webhook_hooks
                WHERE secret_encrypted IS NOT NULL
            `;

        for (const row of rows) {
            if (!Buffer.isBuffer(row.secret_encrypted)) continue;

            const context = isUserTable
                ? userWebhookSecretContext(row.owner_user_id ?? 'unknown')
                : operatorWebhookSecretContext(row.id);

            // Already under the new key AND already bound to its row: a re-run
            // of a partial rotation has nothing to do here.
            let plain: string | null = null;
            try {
                plain = decrypt(row.secret_encrypted, newMasterKey, context);
                if (isAadBoundBlob(row.secret_encrypted)) {
                    rotated++;
                    continue;
                }
            } catch {
                // Not yet under the new key — fall through to the old-key path.
            }

            // Read BEFORE the write, not after.
            const wasLegacy = !isAadBoundBlob(row.secret_encrypted);

            try {
                plain ??= decrypt(row.secret_encrypted, oldMasterKey, context);
                await sql`
                    UPDATE ${sql(table)}
                    SET secret_encrypted = ${encrypt(plain, newMasterKey, context)}
                    WHERE id = ${row.id}::uuid
                `;
                if (wasLegacy) legacyUpgraded++;
                rotated++;
            } catch (err) {
                skipped++;
                reasons.push(`${table} id=${row.id}: ${errMsg(err)}`);
                log.warn('rotate: skipping unreadable webhook secret', {
                    table,
                    hookId: row.id,
                    err: errMsg(err),
                });
            }
        }
    }

    return { rotated, skipped, reasons, legacyUpgraded };
}
