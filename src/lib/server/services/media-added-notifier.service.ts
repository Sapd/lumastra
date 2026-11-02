// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Media-added webhook notifier.
 *
 * Two halves:
 *   1. A pipeline-event handler (registered on `media.becamePlayable`) that runs
 *      INSIDE the dispatcher's per-row transaction: gates out the initial-import
 *      window, hydrates the item, and fans it into media_added_pending — one row
 *      per active hook whose media-type + library-group filters match.
 *   2. A leader-gated flush loop that coalesces staged rows into one batched
 *      `org.lumastra.media.item.added` CloudEvent per due hook and enqueues it
 *      via WebhookOutbox.enqueueToHook.
 */
import type postgres from 'postgres';
import { Logger } from '$lib/server/utils/logger.js';
import { withTx } from '$lib/server/database/with-tx.js';
import { isInitializingWindow } from './attention/attention-service.js';
import { registerPipelineEventHandler } from './pipeline-event-dispatcher.service.js';
import {
    listActiveMediaAddedHooks,
    type MediaAddedHookRow,
} from '$lib/server/database/queries/webhook.queries.js';
import {
    insertPendingMediaAdded,
    listHooksDueForFlush,
    claimPendingForHook,
    deletePendingByIds,
} from '$lib/server/database/queries/media-added-pending.queries.js';
import { buildMediaCloudEvent, type MediaAddedItem } from '$lib/server/tasks/cloud-events.js';
import type { WebhookOutbox } from '$lib/server/tasks/webhook-outbox.js';
import type { PipelineEventPayload } from '$lib/types/pipeline.js';
import {
    hasIntegrationSubscribers,
    publishIntegrationEvent,
} from '$lib/server/plugins/runtime/integration-events.js';

const log = Logger.for('MediaAddedNotifier');

const FLUSH_INTERVAL_MS = 15_000;

/** CloudEvent type published for one item that became playable. */
const MEDIA_ITEM_ADDED_EVENT = 'org.lumastra.media.item.added';

/** Map a raw media_items.media_type (any case) to a notifiable category, or null to suppress. */
export function mediaTypeCategory(raw: string): 'movie' | 'series' | 'episode' | 'album' | null {
    switch (raw.toLowerCase()) {
        case 'movie':
            return 'movie';
        case 'series':
            return 'series';
        case 'episode':
            return 'episode';
        case 'album':
            return 'album';
        default:
            // season / artist / track — containers or over-granular; suppress.
            return null;
    }
}

function asStringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.map(String) : [];
}

/**
 * Staging handler — runs inside the dispatcher's per-row tx. Best-effort: any
 * throw is recorded as an event failure by the dispatcher (retry/backoff).
 */
export async function handleMediaBecamePlayable(
    sql: postgres.Sql,
    payload: PipelineEventPayload,
): Promise<void> {
    if (payload.event !== 'media.becamePlayable') return;

    const category = mediaTypeCategory(payload.mediaType);
    if (category === null) return; // season/artist/track — not notifiable

    // Flood gate: suppress the entire back-catalog during initial setup.
    if (await isInitializingWindow(sql)) return;

    const hooks = await listActiveMediaAddedHooks(sql);
    // NOTE: no early return on an empty hook list. Operator webhooks and plugin
    // integrations are independent subscribers to the same fact — a plugin that
    // subscribed to `media.item.added` must still hear about it on an install
    // where nobody configured a webhook. Only skip the work when BOTH are empty.
    if (hooks.length === 0 && !hasIntegrationSubscribers(MEDIA_ITEM_ADDED_EVENT)) return;

    // Admin/system pipeline: hydrate a single media_items row by PK to build a
    // webhook payload. Webhook subscriptions are admin-configured (webhooks:write);
    // there is no per-user access decision here, so library/age gating does not apply.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    const rows = await sql<
        { id: string; title: string | null; year: number | null; library_group_id: string | null }[]
    >`
        SELECT id, title, year, library_group_id
        FROM media_items
        WHERE id = ${payload.mediaId}::uuid
    `;
    const mi = rows[0];
    if (!mi) return;

    const extRows = await sql<{ provider: string; external_id: string }[]>`
        SELECT provider, external_id
        FROM external_ids
        WHERE media_id = ${payload.mediaId}::uuid
    `;
    const externalIds: Record<string, string> = {};
    for (const e of extRows) externalIds[e.provider] = e.external_id;

    const item: MediaAddedItem = {
        mediaType: category,
        title: mi.title,
        year: mi.year,
        internalId: mi.id,
        externalIds,
        posterPath: `/api/media/${mi.id}/image/poster`,
        libraryGroupId: mi.library_group_id,
    };

    // Plugin integrations get the item directly, one event per item. The
    // operator path below stages rows per hook and batches them on a flush
    // tick; an in-process handler needs neither, and batching would only delay
    // the event and lose the per-item shape a notifier wants.
    void publishIntegrationEvent({ type: MEDIA_ITEM_ADDED_EVENT, payload: item });

    for (const hook of hooks) {
        if (!hookMatches(hook, category, mi.library_group_id)) continue;
        await insertPendingMediaAdded(sql, { hookId: hook.id, mediaItemId: mi.id, payload: item });
    }
}

function hookMatches(
    hook: MediaAddedHookRow,
    category: string,
    libraryGroupId: string | null,
): boolean {
    const mtf = asStringArray(hook.media_type_filter);
    if (mtf.length > 0 && !mtf.includes(category)) return false;
    const lgf = asStringArray(hook.library_group_filter);
    if (lgf.length > 0) {
        if (!libraryGroupId || !lgf.includes(libraryGroupId)) return false;
    }
    return true;
}

function uniformLibraryGroup(items: MediaAddedItem[]): string | null {
    const first = items[0]?.libraryGroupId ?? null;
    return items.every((i) => i.libraryGroupId === first) ? first : null;
}

export class MediaAddedNotifier {
    private timer: ReturnType<typeof setInterval> | null = null;
    private running = false;
    private stopped = false;

    constructor(
        private readonly sql: postgres.Sql,
        private readonly outbox: WebhookOutbox,
        private readonly isLeader: () => boolean,
    ) {}

    /** Register the staging handler. Call once at module wiring time. */
    registerHandler(): void {
        registerPipelineEventHandler('media.becamePlayable', handleMediaBecamePlayable);
    }

    start(): void {
        if (this.timer !== null) return;
        this.stopped = false;
        this.timer = setInterval(() => void this.flushTick(), FLUSH_INTERVAL_MS);
        if (typeof this.timer.unref === 'function') this.timer.unref();
    }

    stop(): void {
        this.stopped = true;
        if (this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    async flushTick(): Promise<void> {
        if (!this.isLeader() || this.running) return;
        this.running = true;
        try {
            const due = await listHooksDueForFlush(this.sql);
            for (const d of due) {
                try {
                    await this.flushHook(d.hook_id, d.max_batch_size);
                } catch (err) {
                    log.warn('MediaAddedNotifier flushHook failed; continuing', {
                        hookId: d.hook_id,
                        err: err instanceof Error ? err.message : String(err),
                    });
                }
            }
        } catch (err) {
            log.warn('MediaAddedNotifier flush tick failed', {
                err: err instanceof Error ? err.message : String(err),
            });
        } finally {
            this.running = false;
        }
    }

    private async flushHook(hookId: string, maxBatchSize: number): Promise<void> {
        const claimed = await withTx(this.sql, async (tx) => {
            const pending = await claimPendingForHook(tx, hookId, maxBatchSize);
            if (pending.length === 0) return [] as { id: string }[];
            const items = pending.map((p) => p.payload);
            const lg = uniformLibraryGroup(items);
            const event = buildMediaCloudEvent(items, lg);
            await this.outbox.enqueueToHook(hookId, event, tx);
            await deletePendingByIds(
                tx,
                pending.map((p) => p.id),
            );
            return pending.map((p) => ({ id: p.id }));
        });
        if (claimed.length > 0) {
            log.info('MediaAddedNotifier flushed batch', { hookId, count: claimed.length });
        }
    }
}
