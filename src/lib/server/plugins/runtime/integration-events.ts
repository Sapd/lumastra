// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Host → integration event dispatch.
 *
 * `IntegrationDefinition.sendNotification` shipped as a declared contract with
 * nothing behind it: the registry stored integrations, but no code path ever
 * called the method. This module is that path.
 *
 * DELIVERY RULES
 *
 *  - **Opt-in.** An integration receives events only if it declares
 *    `subscribes`. Several builtins already implement a no-op
 *    `sendNotification`; none of them should start receiving traffic just
 *    because a dispatcher exists.
 *  - **Fire-and-forget.** Emission sites are task-run bookkeeping and library
 *    scan hooks. A notifier that throws, hangs, or is simply slow must never
 *    fail or stall them, so every handler is isolated and time-boxed and this
 *    function never rejects.
 *  - **At-most-once, in-process.** Unlike the operator webhook outbox there is
 *    no durable queue, no retry, and no cross-replica fan-out: an event is
 *    delivered to the subscribers loaded in THIS process, once. Integrations
 *    that need delivery guarantees should persist what they receive.
 */

import type {
    IntegrationDefinition,
    NotificationEvent,
    PluginContext,
} from '@sapd/lumastra-plugin-sdk';
import { registry as taskRegistry } from '$lib/server/tasks/registry.js';
import { buildPluginContext } from '$lib/server/tasks/plugin-context.js';
import { Logger } from '../../utils/logger.js';

const logger = Logger.for('IntegrationEvents');

/**
 * Every event type the host publishes to plugins.
 *
 * This IS the contract: a plugin's `subscribes` array is matched by exact
 * string, so a rename here silently turns a working notifier into one that
 * receives nothing. Pinned by a test for exactly that reason.
 *
 * Playback events are published to PLUGINS ONLY, never through the operator
 * webhook outbox. An operator hook with an empty `event_filter` means "send me
 * everything", so routing playback there would start flooding existing hooks
 * with an event per heartbeat the moment this shipped.
 */
export const PLUGIN_EVENT_TYPES = [
    'org.lumastra.task.run.started',
    'org.lumastra.task.run.completed',
    'org.lumastra.task.run.failed',
    'org.lumastra.task.run.cancelled',
    'org.lumastra.task.run.cancelling',
    'org.lumastra.task.run.progress',
    'org.lumastra.task.run.stage.completed',
    'org.lumastra.task.cost.threshold.exceeded',
    'org.lumastra.media.item.added',
    'org.lumastra.playback.started',
    'org.lumastra.playback.paused',
    'org.lumastra.playback.resumed',
    'org.lumastra.playback.stopped',
] as const;

export type PluginEventType = (typeof PLUGIN_EVENT_TYPES)[number];

/**
 * What a playback event carries.
 *
 * PRIVACY: this says who is watching what, right now. It is the whole point for
 * a presence or scrobbling plugin, and it is exactly why delivery stays opt-in
 * per event type — an integration receives it only by naming it in
 * `subscribes`, which is visible on the plugin's admin card.
 */
export interface PlaybackEventPayload {
    sessionId: string;
    userId: string;
    mediaId: string;
    /** Milliseconds into the item, when the emitting path knows it. */
    positionMs?: number;
    /** The session's `end_reason` on a `stopped` event. */
    reason?: string;
}

/** Wildcard subscription — every event type the host publishes. */
export const SUBSCRIBE_ALL = '*';

/**
 * Per-handler budget. Generous enough for a handler that posts to a chat API,
 * short enough that a hung one cannot hold up the emitting path. Exceeding it
 * abandons the wait (the handler's own promise keeps running, unobserved) and
 * moves on to the next subscriber.
 */
const HANDLER_TIMEOUT_MS = 10_000;

export interface IntegrationEventDeps {
    listIntegrations(): IntegrationDefinition[];
    buildCtx(integrationId: string): PluginContext;
}

const defaultDeps: IntegrationEventDeps = {
    listIntegrations: () => taskRegistry.getAllIntegrations(),
    buildCtx: (id) => buildPluginContext(id),
};

/** True when `def` asked for this event type (exact match or wildcard). */
function subscribesTo(def: IntegrationDefinition, type: string): boolean {
    const subs = def.subscribes;
    if (!Array.isArray(subs) || subs.length === 0) return false;
    return subs.includes(SUBSCRIBE_ALL) || subs.includes(type);
}

/** Await `p`, giving up after `ms`. Resolves either way; never rejects. */
function withTimeout(p: Promise<unknown>, ms: number): Promise<'ok' | 'timeout' | 'error'> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve('timeout'), ms);
        // `unref` where available so a pending timer cannot hold the process
        // open during shutdown. Not present in browser-shaped test envs.
        (timer as unknown as { unref?: () => void }).unref?.();
        p.then(
            () => {
                clearTimeout(timer);
                resolve('ok');
            },
            () => {
                clearTimeout(timer);
                resolve('error');
            },
        );
    });
}

/**
 * Could an integration actually receive this event type right now?
 *
 * For emitters that must do work BEFORE they can publish (the media-added path
 * hydrates a row and its external ids to build the payload). Requires a usable
 * `sendNotification`, not merely a declared subscription, so a half-written
 * integration never causes that work to happen for nothing. Returns false
 * rather than throwing if the registry is not available.
 */
export function hasIntegrationSubscribers(
    type: string,
    deps: IntegrationEventDeps = defaultDeps,
): boolean {
    try {
        return deps
            .listIntegrations()
            .some((def) => subscribesTo(def, type) && typeof def.sendNotification === 'function');
    } catch {
        return false;
    }
}

/**
 * Publish one host event to every integration subscribed to its type.
 *
 * Never throws and never rejects — callers may `void` it. Subscribers are
 * invoked sequentially: the event rate is low (task lifecycle + library
 * additions), and sequential delivery keeps log output readable and avoids a
 * burst of concurrent outbound calls from a bulk scan.
 */
export async function publishIntegrationEvent(
    event: NotificationEvent,
    deps: IntegrationEventDeps = defaultDeps,
): Promise<void> {
    let subscribers: IntegrationDefinition[];
    try {
        subscribers = deps.listIntegrations().filter((def) => subscribesTo(def, event.type));
    } catch (err) {
        logger.warn('failed to list integrations for event', {
            type: event.type,
            error: err instanceof Error ? err.message : String(err),
        });
        return;
    }
    if (subscribers.length === 0) return;

    for (const def of subscribers) {
        if (typeof def.sendNotification !== 'function') continue;
        try {
            const ctx = deps.buildCtx(def.id);
            const outcome = await withTimeout(
                Promise.resolve(def.sendNotification(ctx, event)),
                HANDLER_TIMEOUT_MS,
            );
            if (outcome === 'timeout') {
                logger.warn('integration event handler timed out', {
                    integration: def.id,
                    type: event.type,
                    timeoutMs: HANDLER_TIMEOUT_MS,
                });
            } else if (outcome === 'error') {
                logger.warn('integration event handler threw', {
                    integration: def.id,
                    type: event.type,
                });
            }
        } catch (err) {
            // Building the context (or a synchronous throw before the promise
            // existed) must not take the remaining subscribers down with it.
            logger.warn('integration event dispatch failed', {
                integration: def.id,
                type: event.type,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
}
