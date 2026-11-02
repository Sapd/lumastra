// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// src/lib/services/sse/admin-event-handler.ts
//
// Single source of truth for handling `admin` SSE events from both:
//   - the per-session SSE reader in play-session-reporter.ts
//   - the user-scoped SSE listener in watch-state-sse.ts

import { toasts } from '$lib/stores/toast.store.js';
import { maintenanceNotice } from '$lib/stores/maintenance-notice.store.svelte.js';

// Stale replay guard: ignore admin_message events older than 60 seconds
const STALE_MESSAGE_TTL_MS = 60_000;

// Dedupe guard: the same broadcast is delivered through two SSE channels
// (per-session and user-level), so without an id check we'd toast twice for
// users who have both streams active (anyone watching content).
const seenIds = new Set<string>();

interface AdminMessageEvent {
    type: 'admin_message';
    id?: string;
    /**
     * Open string on the wire — an unrecognised value decodes to 'info' below
     * rather than dropping the frame. Severity picks a colour; it must never
     * decide WHETHER the message is shown.
     */
    severity?: string;
    message: string;
    durationMs?: number;
    /** Target play session, when the message is for one. See shouldRender(). */
    playSessionId?: string;
    /** Target device, when known. */
    deviceId?: string;
    sentBy: string;
    sentAt: number;
}

interface MaintenanceNoticeEvent {
    type: 'maintenance_notice';
    id: string;
    message: string;
    endsAt: number;
    createdBy: string;
    createdAt: number;
}

/**
 * What THIS client is, so a targeted message can be filtered to it.
 *
 * `/api/v1/events` (and its cookie-auth twin `/api/events/user`) is a
 * PER-USER stream: one user with two signed-in clients has both connections
 * fed the same frames, and the server cannot tell them apart. So an
 * `admin_message` names its target on the frame and the client decides. Pass
 * whatever this listener knows — the session-scoped reader knows its play
 * session, the app-wide listener only knows the device.
 *
 * Omit it entirely and every message renders, which is the pre-targeting
 * behaviour and the reason the parameter is optional.
 */
export interface AdminEventContext {
    playSessionId?: string | null;
    deviceId?: string | null;
}

/**
 * Whether a targeted `admin_message` is for this client.
 *
 * Untargeted (neither field set) → always render; that is the broadcast case.
 * Targeted → render only on a positive match. A client that knows neither its
 * play-session id nor its device id does NOT render a targeted message: the
 * message was addressed to one specific client, and showing it to an
 * unidentifiable one is the failure the target fields exist to prevent.
 */
function shouldRender(event: AdminMessageEvent, ctx: AdminEventContext | undefined): boolean {
    const targeted = event.playSessionId !== undefined || event.deviceId !== undefined;
    if (!targeted) return true;
    if (!ctx) return false;
    if (event.playSessionId !== undefined && ctx.playSessionId) {
        if (event.playSessionId === ctx.playSessionId) return true;
    }
    if (event.deviceId !== undefined && ctx.deviceId) {
        if (event.deviceId === ctx.deviceId) return true;
    }
    return false;
}

interface MaintenanceClearedEvent {
    type: 'maintenance_cleared';
}

type AdminEvent = AdminMessageEvent | MaintenanceNoticeEvent | MaintenanceClearedEvent;

function isAdminEvent(raw: unknown): raw is AdminEvent {
    if (typeof raw !== 'object' || raw === null) return false;
    const obj = raw as Record<string, unknown>;
    return (
        obj.type === 'admin_message' ||
        obj.type === 'maintenance_notice' ||
        obj.type === 'maintenance_cleared'
    );
}

export function handleAdminEvent(raw: unknown, ctx?: AdminEventContext): void {
    if (!isAdminEvent(raw)) return;

    if (raw.type === 'admin_message') {
        // Stale replay guard: skip if sentAt is older than 60s
        if (Date.now() - raw.sentAt > STALE_MESSAGE_TTL_MS) return;
        // Targeting check BEFORE the dedupe bookkeeping: a frame we are not
        // going to render must not claim the id, or the channel that IS the
        // right target would then see it as a duplicate and drop it too.
        if (!shouldRender(raw, ctx)) return;
        // Fallback key handles the rolling-deploy window when an older pod
        // publishes payloads without `id` — same broadcast still dedupes
        // because both copies share sentAt + sentBy + message.
        const dedupeKey = raw.id ?? `${raw.sentAt}|${raw.sentBy}|${raw.message}`;
        if (seenIds.has(dedupeKey)) return;
        seenIds.add(dedupeKey);
        setTimeout(() => seenIds.delete(dedupeKey), STALE_MESSAGE_TTL_MS);
        // Unknown severity → 'info'. The switch below already does that by
        // falling through, which is the required behaviour: a server that adds
        // a fourth severity must not silence the message.
        const severity = raw.severity ?? 'info';
        const duration = raw.durationMs;
        if (severity === 'error') {
            toasts.error(raw.message, duration);
        } else if (severity === 'warning') {
            toasts.warning(raw.message, duration);
        } else {
            toasts.info(raw.message, duration);
        }
    } else if (raw.type === 'maintenance_notice') {
        maintenanceNotice.set({
            id: raw.id,
            message: raw.message,
            endsAt: raw.endsAt,
            createdBy: raw.createdBy,
            createdAt: raw.createdAt,
        });
    } else if (raw.type === 'maintenance_cleared') {
        maintenanceNotice.clear();
    }
}
