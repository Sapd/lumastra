// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * user-event-kinds.ts — the single place every per-user SSE event kind
 * string is written.
 *
 * This is CANONICAL for both client and server. It lives in `shared/`
 * (importable from client code AND from `src/lib/server/**`, per
 * `src/lib/CLAUDE.md`'s "code shared between client and server") specifically
 * so there is exactly one descriptor list rather than a server original with
 * a client mirror that nothing keeps in sync. `src/lib/server/api/event-kinds.ts`
 * re-exports the pieces server code needs under its established names and
 * holds no descriptor data of its own — the per-request `available`
 * computation (`defs/server/index.ts`, depends on
 * `jellyseerrClient`) is the kind of thing that stays server-only and out of
 * this file, because a client bundle must never be able to reach it.
 *
 * See `docs/architecture/user-events.md` for the reasoning. The short version:
 * `ADVERTISED_EVENT_TYPES` used to name strings the wire never emitted
 * (`maintenance.notice`, `maintenance.cleared`, `session.changed`) because
 * nothing tied the advertised list to what the SSE frame actually says after
 * `event:`. **`name` here MUST be that literal wire string, verbatim** — not a
 * taxonomy label, not a tidied-up spelling. `src/lib/server/api/event-kinds.test.ts`
 * enforces this by grepping the real emitters for each `name`.
 *
 * Two classes, because they answer different questions about a missed frame:
 *   - **notification** — an addressed message to a person. Durable row in
 *     `user_notifications`; missing the live frame is recoverable by polling
 *     the inbox.
 *   - **signal** — "your view of X is stale, refetch." Never persisted;
 *     missing the live frame is harmless, the next fetch is correct.
 *
 * This list feeds two independent consumers that must NOT be merged (see the
 * doc's "Non-goals"):
 *   - `defs/server/index.ts` — advertises `available` per
 *     install (config-derived) alongside these static fields.
 *   - `notification-events.service.ts`'s `PERSIST_KINDS` — the notification
 *     entries here are the only ones a durable row is ever written for.
 *
 * An entry here is a promise a client can subscribe on. Adding an emitter is
 * what earns a kind a line here — never the other way around. To add a kind:
 * edit `USER_EVENT_KINDS` below, nowhere else — every consumer (client
 * stores, the server re-export, the capabilities endpoint, the emitter guard
 * test) derives from it.
 */

export type UserEventKindClass = 'notification' | 'signal';

export interface UserEventKindDescriptor {
    /** The literal SSE `event:` field a client receives. Never a label. */
    readonly name: string;
    readonly class: UserEventKindClass;
    /** Whether a missed live frame is recoverable via a durable row. */
    readonly durable: boolean;
}

/**
 * The closed taxonomy. `library.new_episode` and `request.available` have no
 * emitter yet — `user-notifier.service.ts` (docs/architecture/user-events.md,
 * "Emitters and hook points") adds it. They're listed now because the
 * capabilities/persist-list shape is being fixed ahead of that emitter, per
 * the doc's "Where to start" ordering; `event-kinds.test.ts` asserts this
 * list matches reality once that lands, and fails loudly (not silently)
 * until then.
 */
/**
 * The two notification-kind wire strings, named so non-taxonomy consumers
 * (the inbox SQL, the dismissal-sync service, `deriveViewItem`) can reference
 * a kind without retyping the literal. Guard #1 in the doc's "The guard,
 * because a comment is not a mechanism": each wire string exists exactly once.
 */
export const KIND_LIBRARY_NEW_EPISODE = 'library.new_episode';
export const KIND_REQUEST_AVAILABLE = 'request.available';

/**
 * An announcement an administrator addressed to people.
 *
 * Not to be confused with the `admin` SIGNAL kind two lines below it, which is
 * a different feature that happens to share a word. That one is the perishable
 * play-session toast (`broadcastAdminMessage()`): it addresses live SESSIONS,
 * has a 60-second staleness window, and a user who was not watching at that
 * instant was never meant to see it. This one addresses PEOPLE, is durable
 * precisely so someone offline at send time still gets it, and can be pinned
 * above the inbox until it stops being true. They are deliberately not merged
 * — see `docs/architecture/user-events.md`.
 */
export const KIND_ADMIN_BROADCAST = 'admin.broadcast';

/** A Jellyfin app tried to play using an observer token. */
export const KIND_JELLYFIN_READONLY_TOKEN = 'jellyfin.readonly_token';

export const USER_EVENT_KINDS: readonly UserEventKindDescriptor[] = Object.freeze([
    // Device remote control (docs/superpowers/specs/2026-10-16-device-remote-control-design.md).
    // `device.command` / `device.command_cancelled` reach ONLY the target device's own
    // stream and are never replayed; `device.command_status` / `device.state` go to the
    // whole account.
    Object.freeze({ name: 'device.command', class: 'signal', durable: false }),
    Object.freeze({ name: 'device.command_cancelled', class: 'signal', durable: false }),
    Object.freeze({ name: 'device.command_status', class: 'signal', durable: false }),
    Object.freeze({ name: 'device.state', class: 'signal', durable: false }),
    Object.freeze({ name: 'session_changed', class: 'signal', durable: false }),
    Object.freeze({ name: 'watch_state_set_changed', class: 'signal', durable: false }),
    Object.freeze({ name: 'admin', class: 'signal', durable: false }),
    Object.freeze({ name: KIND_LIBRARY_NEW_EPISODE, class: 'notification', durable: true }),
    Object.freeze({ name: KIND_REQUEST_AVAILABLE, class: 'notification', durable: true }),
    Object.freeze({ name: KIND_ADMIN_BROADCAST, class: 'notification', durable: true }),
    Object.freeze({ name: KIND_JELLYFIN_READONLY_TOKEN, class: 'notification', durable: true }),
]);

/** Every advertised kind name — the set a client can `subscribe()` to. */
export const USER_EVENT_KIND_NAMES: readonly string[] = Object.freeze(
    USER_EVENT_KINDS.map((kind) => kind.name),
);

/**
 * The notification-class kind names, derived rather than hand-copied.
 * `notification-events.service.ts`'s `PERSIST_KINDS` sources from this (via
 * the server re-export) — it stays a *separate* list (it answers "does it
 * get a durable row", not "can it be published at all"), but its contents
 * must never be typed out by hand again; that drift is exactly what produced
 * six persisted kinds for a taxonomy that should hold two.
 */
export const NOTIFICATION_EVENT_KIND_NAMES: readonly string[] = Object.freeze(
    USER_EVENT_KINDS.filter((kind) => kind.class === 'notification').map((kind) => kind.name),
);

export type UserEventKind = (typeof USER_EVENT_KIND_NAMES)[number];
