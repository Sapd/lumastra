// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Deliver a remote-control message to a device's sockets, wherever they are.
 *
 * The HTTP command (`POST /Sessions/{id}/Playing/Pause`) can land on one web
 * replica while the target app's WebSocket is held by another. Every message
 * is written to this replica's sockets directly and published once on
 * `jfcompat:rc:v1:deliver`; every replica keeps ONE shared subscription and
 * writes what arrives to its own sockets, skipping messages it published
 * itself (already delivered in-process).
 */

import { randomUUID } from 'node:crypto';
import { publishMessage, subscribeToChannel } from '$lib/server/cache/valkey.js';
import { Logger } from '$lib/server/utils/logger.js';
import { deliverLocal } from './local-sockets';
import type { OutboundMessage } from './protocol';

const logger = Logger.for('JellyfinCompat:RemoteFanout');

export const DELIVER_CHANNEL = 'jfcompat:rc:v1:deliver';

/** Identifies this process's publishes so it can skip its own echoes. */
const REPLICA_ID = randomUUID();

interface Envelope {
    origin: string;
    sessionId: string;
    payload: string;
}

type SubscribeFn = typeof subscribeToChannel;

let subscription: Promise<boolean> | null = null;
let subscribed = false;

function onEnvelope(raw: string): void {
    let env: Envelope;
    try {
        env = JSON.parse(raw) as Envelope;
    } catch {
        return;
    }
    if (env.origin === REPLICA_ID) return;
    if (typeof env.sessionId !== 'string' || typeof env.payload !== 'string') return;
    deliverLocal(env.sessionId, env.payload);
}

/**
 * Establish the shared subscription if it is not up. Concurrent callers share
 * one attempt; a failed attempt is not cached, so the next socket connect
 * retries it.
 */
export function ensureFanoutSubscription(
    subscribe: SubscribeFn = subscribeToChannel,
): Promise<boolean> {
    if (subscribed) return Promise.resolve(true);
    if (subscription) return subscription;
    subscription = (async () => {
        try {
            const unsub = await subscribe(DELIVER_CHANNEL, onEnvelope);
            subscribed = unsub !== null;
            if (!subscribed) {
                logger.warn(
                    'Remote-control fan-out not subscribed; commands reach this replica only',
                );
            }
            return subscribed;
        } catch (err) {
            logger.warn('Remote-control fan-out subscribe failed', { error: String(err) });
            return false;
        } finally {
            subscription = null;
        }
    })();
    return subscription;
}

export interface Delivery {
    /** Sockets reached on this replica. */
    local: number;
    /** Whether the message was published for the other replicas. */
    published: boolean;
}

/**
 * Send `message` to every socket of remote session `sessionId`: written to this
 * replica's sockets at once and published for the others (fire-and-forget).
 * `local === 0 && !published` means nobody can have received it.
 */
export async function deliverToSession(
    sessionId: string,
    message: OutboundMessage,
): Promise<Delivery> {
    const payload = JSON.stringify(message);
    const local = deliverLocal(sessionId, payload);
    const envelope: Envelope = { origin: REPLICA_ID, sessionId, payload };
    const published = await publishMessage(DELIVER_CHANNEL, JSON.stringify(envelope));
    if (!published && local === 0) {
        logger.debug('Remote-control message not published and no local socket', {
            sessionId,
            type: message.MessageType,
        });
    }
    return { local, published };
}

/**
 * Send `message` to every socket of remote session `sessionId`. Resolves to
 * the number of sockets reached on this replica (others are fire-and-forget).
 */
export async function sendToSession(sessionId: string, message: OutboundMessage): Promise<number> {
    return (await deliverToSession(sessionId, message)).local;
}

/** Test-only. */
export function __resetFanoutForTests(): void {
    subscription = null;
    subscribed = false;
}
