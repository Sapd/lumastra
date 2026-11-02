// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The exact `/api/v1/notifications/…` paths whose auth is the in-route `?sig=`
 * HMAC rather than the surface's normal bearer gate.
 *
 * An iOS Notification Service Extension is a separate process that holds no
 * usable bearer token — the signed URL IS the credential, which is the whole
 * reason these two endpoints declare `auth: 'public'`. But `public` only makes
 * mount()'s `enforce()` a no-op; it says nothing to the two gates that run
 * BEFORE a route is ever entered. Both of those require a Bearer header (or an
 * `api_key` query param) on `/api/v1/*`, so without an entry here a signed URL
 * is answered `401 Bearer token required` and the signature check never runs —
 * exactly what shipped, and what made the whole rich-notification feature dead
 * in production while its tests stayed green (they drove the def handlers
 * directly and never crossed the middleware).
 *
 * Two places must therefore agree on this set — `handlePublicApiAuth` in
 * forward-auth.ts and the `isApiV1RequestAuthorized` backstop in
 * hooks.server.ts. A tiny standalone module (no DB, no config) so both can
 * import it without dragging the push stack into boot, and so the two can never
 * drift apart. Same shape and same reason as `audiobook-stream-paths.ts`.
 *
 * **Structural, not `includes()`.** A substring test would widen the exemption
 * far past these two routes: `path.includes('push-image')` is also true of a
 * future `/api/v1/notifications/push-image/settings`, i.e. any sibling reached
 * with an `{id}` an attacker chooses. `csrf.test.ts` already pins the same
 * lesson for its own exempt list ("`/api/joke` must not be exempt for starting
 * with `/j`"). The patterns below match the full path or nothing, and they pin
 * both variable segments: a UUID-shaped id and a known locale.
 */

/**
 * The locale segments `push-content/{locale}` can carry — the SINGLE source for
 * the set, shared with `PushLocale` and with the def's own `z.enum`.
 *
 * Living here rather than beside the sender is deliberate: the locale is a
 * SIGNED PATH SEGMENT, and adding one without widening this matcher would mint
 * URLs that are 401'd before the route sees them — a dead endpoint for that
 * language, and nothing else would fail.
 */
export const PUSH_CONTENT_LOCALE_SEGMENTS = ['en', 'de'] as const;

/** One of the locales a signed `push-content` path may name. */
export type PushContentLocaleSegment = (typeof PUSH_CONTENT_LOCALE_SEGMENTS)[number];

/**
 * A canonical dashed UUID. Deliberately narrower than `isUuid()`, which also
 * accepts the dash-less Jellyfin form: `signUrl` signs the pathname verbatim,
 * and every minted URL carries the dashed `user_notifications.id` postgres
 * returns. A dash-less spelling could never carry a valid signature, so leaving
 * it out costs nothing and keeps the exemption as small as the real traffic.
 */
const UUID_SEGMENT = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

/** `/api/v1/notifications/{uuid}/push-image` */
const PUSH_IMAGE_PATH = new RegExp(`^/api/v1/notifications/${UUID_SEGMENT}/push-image$`);

/** `/api/v1/notifications/{uuid}/push-content/{en|de}` */
const PUSH_CONTENT_PATH = new RegExp(
    `^/api/v1/notifications/${UUID_SEGMENT}/push-content/(?:${PUSH_CONTENT_LOCALE_SEGMENTS.join('|')})$`,
);

/**
 * `notifications/{id}/image` — the artwork URL a forwarded-notification webhook
 * (`org.lumastra.user.notification`) carries. Same posture as `push-image`: the
 * receiver (a bot, n8n) holds no credential valid on this path, and the `?sig=`
 * HMAC (purpose `notification-image`) is verified in-route before any DB read.
 */
const NOTIFICATION_IMAGE_PATH = new RegExp(`^/api/v1/notifications/${UUID_SEGMENT}/image$`);

/**
 * True only for the three signed notification endpoints on the v1 surface
 * (`push-image`, `push-content/{locale}`, `image`).
 *
 * Everything else under `/api/v1/notifications/` — the authenticated list, mark-
 * read and preference routes, and anything added later — keeps the surface's
 * ordinary bearer authentication. The `/api/notifications/…` mirror is NOT
 * covered either, and must not be: signatures are minted for `/api/v1` only
 * (see `push-rich-urls.ts`), and the internal surface is cookie-authenticated.
 */

export function isPushRichSignedPath(pathname: string): boolean {
    return (
        PUSH_IMAGE_PATH.test(pathname) ||
        PUSH_CONTENT_PATH.test(pathname) ||
        NOTIFICATION_IMAGE_PATH.test(pathname)
    );
}
