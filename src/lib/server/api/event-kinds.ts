// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * event-kinds.ts — server-side entry point for the per-user SSE event kind
 * taxonomy.
 *
 * The descriptor list itself is canonical in `$lib/shared/user-event-kinds.ts`
 * — `shared/` because client code (`$lib/stores/user-events.ts`,
 * `$lib/stores/notification-inbox.ts`, `$lib/notifications-desktop.ts`) needs
 * the exact same names and cannot import from `src/lib/server/**`. This file
 * re-exports those under the names server call sites already use
 * (`EVENT_KINDS`, `EventKindDescriptor`, `EventKindClass`,
 * `NOTIFICATION_EVENT_KIND_NAMES`), so `event-kinds.test.ts`,
 * `notification-events.service.ts` and `defs/server/index.ts`
 * needed no changes beyond this file. It is also the place to add anything
 * that is genuinely server-only — currently nothing; the per-request
 * `available` computation lives in `defs/server/index.ts`
 * itself (depends on `jellyseerrClient`) and must stay there rather than
 * move into `shared/`, where a client bundle could reach it.
 *
 * There used to be a second, hand-copied descriptor list here — the one now
 * in `$lib/shared/user-event-kinds.ts` started as a client-side duplicate of
 * this file because client code cannot import `src/lib/server/**`. Nothing
 * enforced the two stayed equal, which is exactly the failure mode this
 * whole taxonomy exists to prevent (see `docs/architecture/user-events.md`).
 * Reconciled by making the shared copy canonical and this file a re-export.
 *
 * See `docs/architecture/user-events.md` for the taxonomy itself: two
 * classes (notification — durable, addressed to a person; signal — never
 * persisted, "your view is stale, refetch"), and why `name` must be the
 * literal SSE `event:` wire string rather than a taxonomy label.
 */

export type {
    UserEventKindClass as EventKindClass,
    UserEventKindDescriptor as EventKindDescriptor,
} from '$lib/shared/user-event-kinds.js';

export {
    USER_EVENT_KINDS as EVENT_KINDS,
    NOTIFICATION_EVENT_KIND_NAMES,
} from '$lib/shared/user-event-kinds.js';
