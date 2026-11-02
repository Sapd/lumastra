// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Zod schemas for the admin broadcast surface (`/api/admin/notifications/**`).
 *
 * An INTERNAL surface: these endpoints are mounted `visibility: 'internal'` and
 * `auth: {kind:'admin'}`, so they are not part of the published `/api/v1`
 * contract and no third-party client decodes them. They still live here rather
 * than inline in the def, because `src/lib/schemas/` is the single source of
 * truth for every wire shape in this codebase and the admin page imports these
 * same schemas to validate its own responses.
 *
 * Own file rather than an append to `api-admin-responses.ts` (3700 lines) —
 * these are a self-contained feature with a request half as well as a response
 * half, and the existing file is response-shaped.
 *
 * The USER-facing side of this feature is not here: a recipient reads a
 * broadcast as an ordinary `InboxNotificationItem` from
 * `notifications-types.ts`. Nothing about `admin_broadcasts` reaches a
 * non-admin — a user sees the announcement, never the record of who sent it.
 */

import { z } from 'zod';

/**
 * Whether an ISO-8601 pin deadline is still in the future.
 *
 * Shared by the send schema and the pin schema so both refuse the same input.
 * A past deadline has to be REJECTED rather than tolerated because the pin write
 * does not consult it: `pinned_at` is set to `now()` unconditionally whenever
 * `pinned` is true, which satisfies the `admin_broadcasts_pin_coherent` CHECK no
 * matter what the expiry says. The row is then stored as pinned, reported as
 * pinned by the admin list's `isPinned`… and filtered out of every recipient's
 * pinned block by `pin_expires_at > now()`, which is already false. The admin
 * sees a successful send and nobody ever sees the pin.
 *
 * `undefined` passes — an omitted deadline means "pin indefinitely", which is
 * the documented default and not a value to validate.
 *
 * Compared against request-handling time rather than against a clock the caller
 * supplies, so the comparison is the same one the SQL predicate will make. A
 * deadline a few milliseconds out survives this and is honestly almost expired;
 * the check is for the already-past case, which is always a mistake.
 */
function isFuturePinDeadline(value: string | undefined): boolean {
    if (value === undefined) return true;
    const parsed = Date.parse(value);
    // NaN can only reach here if `.datetime()` passed something unparseable;
    // let that fall through as valid so the format error is reported by the
    // check that owns it rather than being restated as "must be in the future".
    return Number.isNaN(parsed) || parsed > Date.now();
}

const PIN_DEADLINE_IN_PAST = 'The pin expiry must be in the future';

/**
 * Upper bound on an attached link, in characters.
 *
 * Anchored to the text fields above it rather than to a spec: `title` caps at
 * 200 and `body` at 2000, so a URL an order of magnitude past the body would be
 * something other than a link. 2048 is also the length every practical HTTP
 * stack agrees to carry, which is the number that matters for a value the
 * recipient's browser has to open.
 */
const LINK_URL_MAX_LENGTH = 2048;

/**
 * The only schemes an announcement may point at.
 *
 * The text fields on this request are admin-trusted and stored verbatim. A URL
 * is not the same kind of input: it is handed to a recipient's client as
 * something to OPEN, and `javascript:`/`data:` are executable in that position
 * while `file:` reads the reader's own disk. Trusting the author is not the
 * question — an allowlist is what keeps a mistyped or pasted-from-anywhere value
 * from becoming an execution vector in a thousand inboxes.
 *
 * Allowlist, not a denylist: the set of URL schemes is open-ended and a
 * denylist would have to be extended every time a client learns a new one.
 */
const LINK_URL_ALLOWED_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

const LINK_URL_INVALID = 'The link must be an absolute http:// or https:// URL';

/**
 * Whether an attached link is one this server is willing to store.
 *
 * Absent or empty passes, and means "no link" — the same tolerance `body` has
 * for an empty string, so a client that always sends the key does not have to
 * learn to omit it. Everything else must PARSE as an absolute URL (`new URL`
 * without a base, so a bare `/somewhere` or `example.com` is refused rather
 * than being silently resolved against whatever origin happened to be current)
 * and carry an allowed scheme.
 *
 * Validated HERE, at write time, rather than at render time: the value is copied
 * into every recipient's payload the moment the send succeeds, and a check on
 * the read path would have to be repeated by every surface that ever renders a
 * row — one of which will eventually forget.
 */
function isAllowedLinkUrl(value: string | undefined): boolean {
    if (!value) return true;

    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        // expected: `new URL` throws on anything that is not absolute
        return false;
    }
    return LINK_URL_ALLOWED_PROTOCOLS.has(parsed.protocol);
}

/**
 * Upper bound on an explicit recipient selection. Past a few thousand names the
 * `all` audience is what the admin means; the cap keeps the `= ANY(...)` lookup
 * and the unknown-id 422 (which lists every id it could not resolve) bounded.
 */
const BROADCAST_MAX_USER_IDS = 5000;

/** Who a broadcast was addressed to. Mirrors the DB CHECK constraint. */
export const BroadcastAudienceSchema = z
    .enum(['all', 'users'])
    .describe('Who the broadcast was addressed to');

export type BroadcastAudienceValue = z.infer<typeof BroadcastAudienceSchema>;

/**
 * One row of the admin broadcast log.
 *
 * `.nullable()` rather than `.optional()` throughout the pin block, against the
 * project's general preference, because these genuinely ARE null in the database
 * and this is an internal surface with no Swift decoder to keep simple. The
 * admin table renders "—" for each of them, so the difference between "absent"
 * and "null" would be invisible anyway; matching the column is the more honest
 * shape.
 */
export const AdminBroadcastSchema = z
    .object({
        id: z.string().describe('Broadcast id'),
        title: z.string().describe('Announcement headline'),
        body: z.string().nullable().describe('Announcement body; null = title only'),
        audience: BroadcastAudienceSchema,
        recipientCount: z
            .number()
            .int()
            .describe('How many users it was ADDRESSED to at send time, not how many copies live'),
        pushEnabled: z.boolean().describe('Whether recipients also got an APNs push'),
        pinnedAt: z.string().nullable().describe('ISO-8601 timestamp the pin was placed'),
        pinnedBy: z.string().nullable().describe('Username of the admin who pinned it'),
        pinExpiresAt: z
            .string()
            .nullable()
            .describe('ISO-8601 pin deadline; null = pinned indefinitely'),
        isPinned: z
            .boolean()
            .describe(
                'Whether the pin is in force RIGHT NOW — set and not past its deadline. ' +
                    'Derived server-side; a lapsed pin reports false while pinnedAt still ' +
                    'carries its historical timestamp.',
            ),
        createdBy: z.string().describe('Username of the admin who sent it'),
        createdAt: z.string().describe('ISO-8601 send timestamp'),
    })
    .meta({
        id: 'AdminBroadcast',
        description: 'An admin announcement and its current pin state',
    });

export type AdminBroadcast = z.infer<typeof AdminBroadcastSchema>;

/**
 * Body for POST /api/admin/notifications/broadcast.
 *
 * `title` is trimmed and required; `body` is optional because a one-line
 * announcement is a legitimate thing to send, and the presenter renders a
 * title-only row correctly.
 *
 * `linkUrl` attaches an EXTERNAL destination — "read the migration notes", "the
 * status page" — and it is the one field here that is not simply admin-trusted
 * text. It widens the shipped `NotificationLink.target` set with a `'url'`
 * variant, which was safe to do only because that set is contractually OPEN: a
 * client that does not recognise a target treats the link as absent rather than
 * failing to decode the row, so an iOS build that has never heard of `'url'`
 * renders the announcement and simply does not make it tappable. There is still
 * no in-app (media) destination for an announcement — that was a separate
 * product decision and remains out of scope.
 */
export const SendBroadcastRequestSchema = z
    .object({
        title: z
            .string()
            .trim()
            .min(1, 'Title cannot be empty')
            .max(200)
            .describe('Announcement headline (1–200 chars, trimmed)'),
        body: z
            .string()
            .trim()
            .max(2000)
            .optional()
            .describe('Announcement body (up to 2000 chars, trimmed)'),
        linkUrl: z
            .string()
            .trim()
            .max(LINK_URL_MAX_LENGTH)
            .optional()
            .describe(
                'Absolute http(s) URL a recipient opens by tapping the announcement. ' +
                    'Omit (or send empty) for an announcement that is not a link.',
            ),
        audience: BroadcastAudienceSchema,
        userIds: z
            .array(z.string().uuid())
            .max(BROADCAST_MAX_USER_IDS)
            .optional()
            .describe('Recipient user ids; required when audience is "users"'),
        pinned: z.boolean().describe('Pin the announcement above every recipient inbox'),
        pinExpiresAt: z
            .string()
            .datetime()
            .optional()
            .describe('ISO-8601 pin deadline; omit to pin indefinitely. Ignored unless pinned.'),
        pushEnabled: z
            .boolean()
            .describe(
                'Also send an APNs push. When false the announcement still lands in the inbox, ' +
                    'on the SSE wire and in the user webhook — only the lock-screen banner is ' +
                    'skipped.',
            ),
    })
    // Cross-field, because the two audiences need different things and a
    // `userIds`-less "users" send would otherwise resolve to zero recipients and
    // be reported as an empty-audience failure — technically true, unhelpfully
    // phrased. Checking it here names the actual mistake.
    .refine((v) => v.audience !== 'users' || (v.userIds?.length ?? 0) > 0, {
        message: 'Select at least one user when the audience is "users"',
        path: ['userIds'],
    })
    // The other direction of the same cross-field rule, and it needs stating
    // separately because `resolveRecipients` does not look at `userIds` at all
    // for the `all` audience. A caller who sent both got a broadcast to EVERY
    // user with no indication that the selection they made was discarded — and
    // the caller who can do this is a PAT-scoped admin script, not the compose
    // page (which never sends the combination). Between "reached everyone" and
    // "reached the twelve people I named", guessing is not acceptable.
    .refine((v) => v.audience !== 'all' || (v.userIds?.length ?? 0) === 0, {
        message: 'Do not send userIds when the audience is "all" — it addresses every user',
        path: ['userIds'],
    })
    // Only when pinning: an unpinned send ignores the deadline (the insert stores
    // NULL), so a stale value a client echoes must not fail the whole send.
    .refine((v) => !v.pinned || isFuturePinDeadline(v.pinExpiresAt), {
        message: PIN_DEADLINE_IN_PAST,
        path: ['pinExpiresAt'],
    })
    // Scheme allowlist and absoluteness, both refused here rather than at
    // render time — see `isAllowedLinkUrl`. Nothing downstream re-checks this,
    // by design: the value is copied into every recipient's payload on a
    // successful send, and this is the last point at which refusing it costs
    // one 422 instead of a repair.
    .refine((v) => isAllowedLinkUrl(v.linkUrl), {
        message: LINK_URL_INVALID,
        path: ['linkUrl'],
    })
    .meta({
        id: 'SendBroadcastRequest',
        description: 'Admin broadcast send request',
    });

export type SendBroadcastRequest = z.infer<typeof SendBroadcastRequestSchema>;

/**
 * Response to a successful send.
 *
 * Carries all three counts because they are three different facts and the
 * difference is only visible here. `recipientCount` is the AUDIENCE, fixed when
 * the parent row was written; `deliveredCount` is how many durable inbox rows
 * actually landed; `failedCount` is the remainder. On an ordinary send the first
 * two are equal and the third is zero — which is exactly why reporting only
 * `recipientCount` looked correct while hiding every partial failure behind it
 * (a recipient deleted mid-fan-out FK-violates, and the emitter logs that rather
 * than raising).
 */
export const SendBroadcastResponseSchema = z
    .object({
        id: z.string().describe('Broadcast id'),
        recipientCount: z.number().int().describe('How many users it was addressed to'),
        deliveredCount: z
            .number()
            .int()
            .describe('How many recipients the announcement actually reached'),
        failedCount: z
            .number()
            .int()
            .describe(
                'How many recipients it did NOT reach. Non-zero means a PARTIAL send: the ' +
                    'announcement exists and most recipients have it, so re-sending would ' +
                    'duplicate it for them — surface this rather than retrying blindly.',
            ),
        pinnedAt: z.string().nullable().describe('ISO-8601 pin timestamp; null = not pinned'),
    })
    .meta({
        id: 'SendBroadcastResponse',
        description: 'Result of sending an admin broadcast',
    });

export type SendBroadcastResponse = z.infer<typeof SendBroadcastResponseSchema>;

/** Response to GET /api/admin/notifications/broadcasts. */
export const AdminBroadcastListResponseSchema = z
    .object({
        items: z.array(AdminBroadcastSchema).describe('Recent broadcasts, newest first'),
    })
    .meta({
        id: 'AdminBroadcastListResponse',
        description: 'Recent admin broadcasts',
    });

export type AdminBroadcastListResponse = z.infer<typeof AdminBroadcastListResponseSchema>;

/**
 * Body for PATCH /api/admin/notifications/broadcasts/{id}.
 *
 * Pin state is the ONLY mutable property of a sent broadcast. There is no edit
 * endpoint for the text, by product decision and for the same reason every
 * other notification kind is immutable: the row has already been copied into
 * every recipient's inbox and mirrored into however many push banners, so an
 * edit would leave the two disagreeing forever. Retraction is deletion, which
 * cascades to every copy.
 *
 * `pinExpiresAt` is optional-only, never nullable: omitting it when pinning
 * means "pin indefinitely", and unpinning clears the whole pin block anyway, so
 * an explicit `null` would be a third spelling of something already expressible.
 * (It also sidesteps the optional-plus-nullable shape that collapses into one
 * unusable Optional in generated clients.)
 */
/**
 * The pin request's FIELDS, without the cross-field refinement.
 *
 * Exists only so the PATCH def can `.partial()` it: Zod refuses `.partial()` on
 * a schema carrying refinements (they were written against the whole object and
 * cannot be re-checked against a subset of it), and that def needs an
 * all-optional body because one `request.body` is declared for PATCH and DELETE
 * together and a bodyless DELETE must not 422. Nothing is lost — the def
 * re-parses with the refined {@link SetBroadcastPinRequestSchema} inside PATCH,
 * which is where the strictness was already being restored.
 *
 * {@link SetBroadcastPinRequestSchema} is the contract. This is a building
 * block; do not validate a PATCH body against it alone.
 */
export const SetBroadcastPinRequestFieldsSchema = z.object({
    pinned: z.boolean().describe('True to pin, false to unpin'),
    pinExpiresAt: z
        .string()
        .datetime()
        .optional()
        .describe('ISO-8601 pin deadline; omit to pin indefinitely. Ignored when unpinning.'),
});

export const SetBroadcastPinRequestSchema = SetBroadcastPinRequestFieldsSchema
    // Same rule as the send schema, and refused here for the same reason: a
    // past deadline pins the row in form and unpins it in substance, and the
    // admin is told it worked. See `isFuturePinDeadline`. Unpinning clears the
    // whole pin block, so a deadline sent along with `pinned: false` (a client
    // echoing a lapsed pin's expiry) is ignored rather than refused.
    .refine((v) => !v.pinned || isFuturePinDeadline(v.pinExpiresAt), {
        message: PIN_DEADLINE_IN_PAST,
        path: ['pinExpiresAt'],
    })
    .meta({
        id: 'SetBroadcastPinRequest',
        description: 'Pin or unpin an admin broadcast',
    });

export type SetBroadcastPinRequest = z.infer<typeof SetBroadcastPinRequestSchema>;
