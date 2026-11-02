// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Active-sessions visibility helper — the SINGLE source of truth for "which
 * currently-streaming sessions is THIS viewer allowed to see".
 *
 * The `/api/sessions` endpoint (home-page "Active Streams" widget) and the AI
 * assistant's `get_active_streams` tool both call {@link getVisibleActiveSessions}
 * so the exact same permission gate, per-user privacy filter, preview handling,
 * device-info redaction, and device-client enrichment apply in both places.
 * This logic used to live inline in the route handler; it was lifted here so
 * the assistant could not accidentally diverge from it.
 *
 * @module server/services/active-sessions-view.service
 */

import { mergeLiveTvSessions } from './livetv-active-sessions.service.js';
import { getAudiobookImageRevisions } from '$lib/server/database/queries/resource-images.queries.js';
import { audiobookImageSet } from './image-descriptor/resources.js';
import { MediaAggregationService } from './media-aggregation.service.js';
import { mergeDirectAudiobookshelfSessions } from './audiobookshelf-direct-sessions.service.js';
import { aiDbService } from './database.service.js';
import { prefetchAllDeviceSessions } from './play-session-device.service.js';
import {
    redactSessionAdaptive,
    resolveSessionAdaptive,
} from './adaptive-playback-state.service.js';
import { features } from '../config.js';
import { isUserAdmin } from '../auth.js';
import { Logger } from '../utils/logger.js';
import { getOrComputeSingleFlight } from '../cache/single-flight.js';
import { filterAccessibleMediaIds } from '../utils/media-access-batch.js';
import {
    boundaryCacheKey,
    denyAllAccess,
    isUnrestricted,
    type MediaAccessBoundary,
} from '../database/queries/builders/media-access-boundary.js';
import { getDb } from '../database/connection.js';
import { getPosterPathsByMediaIds } from '../database/queries/session-artwork.queries.js';
import { UUID_RE } from '../../utils/id-patterns.js';
import { getExternalIdFor } from '../../utils/external-ids.js';
import { buildPublicArtworkUrl } from '../../shared/public-artwork-url.js';
import type { ResolvedMetadataLanguages } from '../utils/metadata-language-resolve.js';
import type { StreamSession } from '../types.js';

const logger = Logger.for('ActiveSessionsView');

/** The viewer asking to see active sessions. */
export interface SessionViewer {
    /**
     * Viewer's stable `users.id` UUID. Authoritative for "is this session
     * mine" — see {@link isOwnSession}. Optional only for callers that
     * predate this field; omitting it degrades own-session matching to
     * username-only, which is the pre-existing (weaker) behavior, not a
     * regression.
     */
    userId?: string;
    /** Viewer's username (used to always show their own sessions). */
    username?: string;
    /** Viewer's groups (admin determination fallback — see `isAdmin`). */
    userGroups: string[];
    /**
     * Viewer's already-resolved admin status, when the caller has one (e.g.
     * `locals.user?.isAdmin` / `locals.principal?.isAdmin` / an assistant
     * tool's `ctx.userIsAdmin`). That resolution accounts for the DB
     * `admin_pinned`/`is_admin` override, which plain IdP-group membership
     * does not. When omitted, admin status falls back to
     * `isUserAdmin(userGroups)` — group-only, and blind to the override.
     */
    isAdmin?: boolean;
    /** Whether the viewer has watch permission (parsed in hooks). */
    hasWatchPermission: boolean;
    /**
     * Whether the viewer may access Live TV at all (all-or-nothing capability —
     * there is no per-channel grant). Non-admin viewers without this must not
     * see OTHER users' Live TV ('tvchannel') streams in the widget/assistant
     * tool, even when sessions are otherwise public.
     */
    hasLiveTvPermission: boolean;
    /**
     * The viewer's media access boundary (library groups AND age ceiling), built
     * with the same helpers search and the home rows use:
     * `searchAccessBoundary(await buildSearchAccessContext(sql, user))`.
     * Applied to OTHER users' sessions: a viewer only sees what they could open
     * themselves. Ignored for admins. When omitted for a non-admin the boundary
     * fails closed (deny-all), so a new caller cannot silently skip the check.
     */
    access?: MediaAccessBoundary;
    /**
     * Viewer's resolved metadata-language overlay. When present (and a
     * non-primary language resolves), each session's title/overview is swapped
     * to the viewer's preferred-language translation — the same overlay the
     * media modal applies — so the Active Streams widget doesn't show
     * original-language titles to a viewer who selected another language.
     * Omit / no-overlay result → titles served as-is (zero extra queries).
     */
    metadataLangs?: ResolvedMetadataLanguages;
}

export interface VisibleSessionsResult {
    /** Sessions the viewer is allowed to see (privacy- and preview-filtered). */
    sessions: StreamSession[];
    /** Read timestamp (positions are read fresh per request). */
    cacheTimestamp: number;
    /**
     * False when the feature gate denies this viewer ANY visibility
     * (sessions are not public and the viewer is neither admin nor
     * watch-permissioned). When false, `sessions` is empty.
     */
    visible: boolean;
}

/**
 * Load the per-user `hide_streams` privacy settings. Returns a set-like map of
 * lowercased usernames that have privacy enabled, or `null` when the settings
 * could not be read. Callers must treat `null` as "everyone may be hidden":
 * defaulting to public visibility used to expose every hidden user's stream
 * to other viewers whenever the read failed.
 */
async function getUserPrivacySettings(): Promise<Map<string, boolean> | null> {
    const privacyMap = new Map<string, boolean>();

    try {
        const sql = await aiDbService.getSql();
        if (!sql) {
            logger.warn('Database not available for privacy settings; showing own sessions only');
            return null;
        }

        const privacySettings = await sql<{ username: string; hide_streams: boolean }[]>`
            SELECT username, hide_streams FROM users WHERE hide_streams = true
        `;

        for (const setting of privacySettings) {
            // Normalize username to lowercase for case-insensitive matching
            privacyMap.set(setting.username.toLowerCase(), true);
        }
    } catch (error) {
        logger.warn('Failed to load privacy settings; showing own sessions only', error as Error);
        return null;
    }

    return privacyMap;
}

/**
 * Match a session row against the viewer's own identity.
 *
 * `userId` is authoritative when the session carries one — it is the
 * canonical user-data key and survives cases where `session.username` fell
 * back to a raw `user_id` UUID (session-read-model.service.ts:137) or
 * diverges from the caller's current display name. Only when a session has
 * no `userId` do we fall back to a case-insensitive `username` compare.
 *
 * This is the SINGLE source of truth for "is this session mine" inside the
 * service — every own-session exemption below (privacy, Live TV, library
 * access, `restrictToOwn`) calls this instead of re-deriving a username
 * compare, specifically so none of them can drift from `restrictToOwn`'s
 * definition of "own" the way `restrictToOwn` itself used to drift from the
 * `/sessions` route handler's `scope=mine` filter (both now import this same
 * function — see `defs/sessions/index.ts`).
 *
 * The `'unknown'` sentinel guard is load-bearing, not decorative:
 * audiobookshelf-direct-sessions.service.ts:220 assigns `username: … ??
 * 'unknown'` to upstream listeners it could not match to a local account.
 * Without this guard, a Lumastra account literally named `unknown` would
 * inherit every unmatched stranger's session — a new leak introduced by the
 * fix for a leak.
 */
export function isOwnSession(
    session: { userId?: string | null; username: string },
    viewerUserId: string | undefined,
    viewerUsername: string | undefined,
): boolean {
    if (session.userId) {
        return viewerUserId != null && session.userId === viewerUserId;
    }
    if (!viewerUsername) return false;
    const sessionUsername = session.username.toLowerCase();
    if (sessionUsername === 'unknown') return false;
    return sessionUsername === viewerUsername.toLowerCase();
}

/**
 * Return the active sessions this viewer is permitted to see, applying the
 * full permission + privacy pipeline used by the `/api/sessions` widget:
 *
 * 1. Feature gate — non-public sessions are hidden from users who are neither
 *    admin nor watch-permissioned (returns `visible: false`, empty sessions).
 * 2. Preview tagging + non-admins never see hover-preview sessions.
 * 3. Device-client enrichment (clientApp / clientPlayerName).
 * 4. Privacy — admins see everything (with `isPrivate` flag); everyone else
 *    sees their own sessions plus other users' sessions that are not hidden.
 * 5. Device-info redaction — client/browser names and form factor are stripped unless
 *    device info is public, or the viewer is watch-permissioned / admin.
 */
export async function getVisibleActiveSessions(
    viewer: SessionViewer,
): Promise<VisibleSessionsResult> {
    const isAdmin = viewer.isAdmin ?? isUserAdmin(viewer.userGroups || []);
    const hasWatchPermission = viewer.hasWatchPermission;
    const hasLiveTvPermission = viewer.hasLiveTvPermission;

    // A viewer can ALWAYS see their OWN active sessions (so they can stop their
    // own stream from the home widget / settings page). When sessions are not
    // public and the viewer is neither admin nor watch-permissioned, we do NOT
    // hide everything — instead we restrict the result to the viewer's own
    // sessions. `visible` stays true in that case; only OTHER users' sessions
    // are withheld. Privileged viewers (public / admin / watch) are unrestricted.
    const restrictToOwn = !features.sessionsPublic && !isAdmin && !hasWatchPermission;
    // Admins are never boundary-filtered; a non-admin without a boundary fails closed.
    const access: MediaAccessBoundary | null = isAdmin ? null : (viewer.access ?? denyAllAccess());

    // Very-short-TTL single-flight around the expensive build. The home load
    // asks for the active-sessions view up to ~3x (SSR widget + assistant tool
    // + client hydration), each fanning out play_sessions + device-cache +
    // per-user privacy reads. Collapsing that to one computation per ~2s window
    // keeps the widget near-live while removing the redundant work.
    //
    // The key captures EVERYTHING the output depends on: the viewer's group
    // set (drives the underlying session filter AND admin determination), their
    // username (own-session visibility + privacy), and the watch permission
    // (device-info redaction — AND whether direct AudiobookShelf listeners with
    // no Lumastra account are included, so that merge needs no new key
    // component). Two viewers with different access never share an
    // entry. TTL is 2s so positions stay effectively live (the endpoint itself
    // still sends no-store; this is server compute memoization, not HTTP cache).
    const groupKey = [...(viewer.userGroups || [])].sort().join(',');
    // The watch-party overlay (end of the build) withholds join codes when the
    // admin disabled the watch-parties listing — that is OUTPUT, so it is keyed
    // too; otherwise a toggle keeps serving codes from a cached build.
    const partyKey = features.watchTogether
        ? (await import('../utils/widget-guard.js')).isWidgetDisabled('watch-parties')
            ? 'p-'
            : 'p+'
        : 'p0';
    const viewerKey = [
        'v2',
        // userId is the AUTHORITATIVE own-session key (see isOwnSession), so it
        // is part of the output: it decides which rows survive the privacy
        // filter, the Live TV / library gates, and restrictToOwn. It was
        // missing from this key, which made two calls differing ONLY in whether
        // they supplied it collapse onto one cached build — so a caller that
        // omitted it could poison the entry for a caller that supplied it, and
        // the symptom would be order- and timing-dependent within the 2s TTL.
        // The `/sessions` def used to be exactly that pair (scope=mine omitted
        // it, scope=visible supplied it); it no longer is, and this makes the
        // next such caller a cache miss instead of a heisenbug.
        viewer.userId ?? '',
        (viewer.username ?? '').toLowerCase(),
        isAdmin ? 'a' : '-',
        hasWatchPermission ? 'w' : '-',
        // Live TV capability gates every 'tvchannel' session (below) —
        // must be part of the key or two viewers differing only on this would
        // share a cached build and leak/hide Live TV sessions incorrectly.
        hasLiveTvPermission ? 'tv' : '-',
        // CRITICAL: restrictToOwn changes the OUTPUT (own-only vs own+visible),
        // so it MUST be part of the key — otherwise a restricted viewer and a
        // privileged viewer could share a cached entry and leak other users'
        // sessions across the privacy boundary.
        restrictToOwn ? 'o' : '-',
        // The access boundary (denied library groups + age ceiling) decides which
        // OTHER users' rows survive, so two viewers with the same groups but a
        // different age limit must never share a cached build.
        access ? boundaryCacheKey(access) : 'admin',
        // Language overlay is part of the OUTPUT (localized titles), so it must
        // be in the key — otherwise two viewers in the same groups but different
        // languages would share one cached (wrong-language) build.
        `l:${viewer.metadataLangs?.titleLang ?? ''}.${viewer.metadataLangs?.textLang ?? ''}`,
        partyKey,
        groupKey,
    ].join('|');
    const cacheKey = `sf:active-sessions-view:v3:${viewerKey}`;

    const json = await getOrComputeSingleFlight({
        cacheKey,
        ttlSeconds: 2,
        lockTtlSeconds: 5,
        compute: async () =>
            JSON.stringify(
                await buildVisibleActiveSessions(
                    viewer,
                    isAdmin,
                    hasWatchPermission,
                    hasLiveTvPermission,
                    restrictToOwn,
                    access,
                ),
            ),
    });

    try {
        return JSON.parse(json) as VisibleSessionsResult;
    } catch {
        // Malformed cache payload — degrade to a direct build rather than fail.
        return buildVisibleActiveSessions(
            viewer,
            isAdmin,
            hasWatchPermission,
            hasLiveTvPermission,
            restrictToOwn,
            access,
        );
    }
}

/**
 * Uncached body of {@link getVisibleActiveSessions} — the full permission +
 * privacy + enrichment pipeline. Split out so the public entry point can wrap
 * it in single-flight.
 */
async function buildVisibleActiveSessions(
    viewer: SessionViewer,
    isAdmin: boolean,
    hasWatchPermission: boolean,
    hasLiveTvPermission: boolean,
    restrictToOwn: boolean,
    access: MediaAccessBoundary | null,
): Promise<VisibleSessionsResult> {
    const userPermissions = viewer.userGroups || [];
    const sessionResult = await MediaAggregationService.getActiveSessions(userPermissions);

    let sessions = await mergeLiveTvSessions(sessionResult.sessions);

    // Merge AudiobookShelf's OWN listeners — people in the ABS mobile app, who
    // have no play_sessions row at all. Runs here, on the UNFILTERED list, and
    // nowhere later: the merge subtracts upstream sessions that our own rows
    // already claim, and it can only do that while every one of our rows is
    // still present. After the privacy filter, a listener with `hide_streams`
    // set would have lost their Lumastra row, failed to claim its upstream id,
    // and reappeared as a "direct" row — leaking the one person who opted out.
    //
    // The merged rows then flow through the SAME pipeline as everything else:
    // preview tagging (no-op), device enrichment (no-op — they carry no
    // playSessionId of ours), the per-user privacy filter, restrictToOwn, and
    // the language overlay. Nothing below needs to know they arrived late.
    sessions = await mergeDirectAudiobookshelfSessions(sessions, {
        isAdmin,
        hasWatchPermission,
    });

    // Tag preview sessions (playSessionId starts with 'preview-').
    sessions = sessions.map((session) => ({
        ...session,
        isPreview: session.playSessionId?.startsWith('preview-') ?? false,
    }));

    // Non-admins never see preview sessions.
    if (!isAdmin) {
        sessions = sessions.filter((session) => !session.isPreview);
    }

    // Enrich with client app info from the device-session cache.
    const deviceSessions = await prefetchAllDeviceSessions();
    sessions = sessions.map((session) => {
        if (session.playSessionId) {
            const clientInfo = deviceSessions.byPlaySessionId.get(session.playSessionId);
            if (clientInfo) {
                return {
                    ...session,
                    clientApp: clientInfo.clientApp,
                    clientPlayerName: clientInfo.clientPlayerName,
                };
            }
        }

        if (session.deviceId && session.username) {
            const clientInfo = deviceSessions.byDeviceUser.get(
                `${session.deviceId}:${session.username}`,
            );
            if (clientInfo) {
                return {
                    ...session,
                    clientApp: clientInfo.clientApp,
                    clientPlayerName: clientInfo.clientPlayerName,
                };
            }
        }

        return session;
    });

    // Adaptive-bitrate state (Live TV ladder from segment fetches, plus what ABR
    // players report on their heartbeat). Display-only; empty when nothing is adaptive.
    {
        const adaptive = await resolveSessionAdaptive(
            sessions.flatMap((session) =>
                // First-party Live TV was joined by feed + exact viewer key above.
                // Rejoining by station/user here could pick another device's rung.
                session.playSessionId &&
                !(session.mediaType === 'tvchannel' && session.sessionSource === 'lumastra')
                    ? [
                          {
                              sessionId: session.playSessionId,
                              username: session.username,
                              mediaType: session.mediaType,
                              mediaId: session.mediaItemId,
                              deviceId: session.deviceId,
                          },
                      ]
                    : [],
            ),
        );
        if (adaptive.size > 0) {
            sessions = sessions.map((session) => {
                const state = session.playSessionId
                    ? adaptive.get(session.playSessionId)
                    : undefined;
                return state ? { ...session, adaptive: state } : session;
            });
        }
    }

    // Public artwork enrichment — one batch query for the whole list.
    //
    // Placed before the privacy filter purely for efficiency (the list only
    // shrinks from here). It is viewer-independent: the URL derives from the
    // media item alone, so it needs no addition to the single-flight cache key.
    //
    // Episodes have no TMDB poster of their own (only a still image; the
    // poster belongs to the series), so `mediaItemId` alone misses artwork for
    // every episode session. `seriesId` is the documented fallback — but it
    // also carries an ALBUM id for music tracks, which is not a UUID and would
    // throw against the query's `::uuid[]` cast, so it must be UUID-guarded
    // the same way the library-groups check further down guards it.
    {
        const idSet = new Set<string>();
        for (const session of sessions) {
            if (session.mediaItemId) idSet.add(session.mediaItemId);
            if (session.seriesId && UUID_RE.test(session.seriesId)) idSet.add(session.seriesId);
        }
        const mediaIds = [...idSet];
        const sql = getDb();
        if (sql && mediaIds.length > 0) {
            const posterPaths = await getPosterPathsByMediaIds(sql, mediaIds);
            sessions = sessions.map((session) => {
                const url =
                    buildPublicArtworkUrl(posterPaths.get(session.mediaItemId)) ??
                    (session.seriesId && UUID_RE.test(session.seriesId)
                        ? buildPublicArtworkUrl(posterPaths.get(session.seriesId))
                        : undefined);
                return url ? { ...session, artworkPublicUrl: url } : session;
            });
        }
    }

    // Privacy: admins see all (flagged); everyone else only their own + visible.
    const privacySettings = await getUserPrivacySettings();

    if (isAdmin) {
        sessions = sessions.map((session) => {
            const sessionUsername = session.username.toLowerCase();
            const isPrivate = privacySettings?.get(sessionUsername) ?? false;
            return { ...session, isPrivate };
        });
    } else {
        sessions = sessions.filter((session) => {
            if (isOwnSession(session, viewer.userId, viewer.username)) {
                return true;
            }
            // Unknown settings: fail closed, other users' rows are withheld.
            if (!privacySettings) return false;
            const sessionUsername = session.username.toLowerCase();
            const isHidden = privacySettings.get(sessionUsername) ?? false;
            return !isHidden;
        });
    }

    // Other users' connection telemetry (bandwidth, stalls, switch times) is for
    // admins; a non-admin sees only which variant someone else plays.
    if (!isAdmin) {
        sessions = sessions.map((session) =>
            session.adaptive && !isOwnSession(session, viewer.userId, viewer.username)
                ? { ...session, adaptive: redactSessionAdaptive(session.adaptive) }
                : session,
        );
    }

    // Library & Live TV access: non-admin viewers must not see OTHER users'
    // streams for content they themselves lack access to — this used to be a
    // gap (MediaAggregationService.getActiveSessions accepted a
    // userPermissions param but never applied it), so a library- or LiveTV-
    // restricted user on a public/watch-permissioned viewer path could see
    // titles and channels from libraries/Live TV they have no access to. The
    // Live TV permission is absolute, including for an admin or the owner:
    // a revoked viewer must not receive fresh channel/program metadata here.
    // The owner exemption for library/privacy checks remains separate below.
    if (!hasLiveTvPermission) {
        sessions = sessions.filter((session) => session.mediaType !== 'tvchannel');
    }
    if (!isAdmin && access && !isUnrestricted(access)) {
        // Library groups AND age ceiling (incl. the series-rating rule for
        // episodes): batch-check the others' media items against the viewer's
        // boundary, via the same predicate builders search and the home rows use.
        const others = (session: { mediaType: string }) => session.mediaType !== 'tvchannel';
        const isOthers = (session: StreamSession) =>
            others(session) && !isOwnSession(session, viewer.userId, viewer.username);
        const sql = await aiDbService.getSql();
        const candidateIds = [
            ...new Set(
                sessions
                    .filter(isOthers)
                    .map((session) => session.mediaItemId)
                    .filter((id): id is string => !!id && UUID_RE.test(id)),
            ),
        ];
        // No database: fail closed for everyone else's rows.
        const allowedIds =
            sql && candidateIds.length > 0
                ? await filterAccessibleMediaIds(sql, candidateIds, access)
                : new Set<string>();
        const ageLimited = access.age.kind !== 'any';
        sessions = sessions.filter((session) => {
            if (!isOthers(session)) return true;
            // A non-UUID media id (unmatched external listener) has no local
            // row to check. Library-only restriction keeps the old pass-through;
            // under an age limit its rating is unknown, so it is withheld.
            if (!session.mediaItemId || !UUID_RE.test(session.mediaItemId)) return !ageLimited;
            return allowedIds.has(session.mediaItemId);
        });
    }

    // Restricted viewers (non-public sessions, non-admin, no watch permission)
    // may see ONLY their own sessions. This runs AFTER the privacy/preview
    // pipeline as a final hard guard so no other user's session can ever leak
    // out on the restricted path, regardless of the per-user privacy settings.
    //
    // Uses isOwnSession() (userId-first, username-fallback) rather than a bare
    // username compare: session.username can be a raw user_id UUID fallback
    // (session-read-model.service.ts:137) when the users row join came up
    // empty, which would never equal the viewer's real username and silently
    // drop the caller's own session right here — before the /sessions route's
    // scope=mine filter ever saw it.
    if (restrictToOwn) {
        sessions = sessions.filter((session) =>
            isOwnSession(session, viewer.userId, viewer.username),
        );
    }

    // Build and raw User-Agent diagnostics are reserved for administrators.
    if (!isAdmin) {
        sessions = sessions.map(({ clientVersion, userAgent, ...session }) => {
            void clientVersion;
            void userAgent;
            return session;
        });
    }

    // Strip device info if the viewer is not allowed to see it.
    const canSeeDeviceInfo = features.sessionsDeviceInfoPublic || hasWatchPermission || isAdmin;
    if (!canSeeDeviceInfo) {
        sessions = sessions.map((session) => {
            const { clientname, browsername, formFactor, clientFeatures, isCarPlay, ...rest } =
                session;
            void clientname;
            void browsername;
            void formFactor;
            // Redacted with the rest of the device info: a feature list is a
            // statement about someone else's client, and this branch is the
            // "you may not see whose device that is" case.
            void clientFeatures;
            void isCarPlay;
            return rest;
        });
    }

    // Per-viewer metadata-language overlay (multilingual-media-metadata §5):
    // swap each session's title/overview to the viewer's preferred-language
    // translation, keyed on the item's own media_id (session.mediaItemId) — the
    // same overlay the media modal applies. Runs INSIDE the single-flight build
    // (language is in the cache key) so widget-poll cache hits stay instant.
    // No-op / zero queries when no non-primary language resolves.
    const langs = viewer.metadataLangs;
    if (langs && (langs.titleLang || langs.textLang) && sessions.length > 0) {
        try {
            const sql = await aiDbService.getSql();
            if (sql) {
                const [{ applyTranslationOverlay }, { UUID_RE }] = await Promise.all([
                    import('../utils/translation-overlay.js'),
                    import('../../utils/id-patterns.js'),
                ]);
                await applyTranslationOverlay(sql, sessions, langs, {
                    id: (s) => {
                        const id = s.mediaItemId ?? s.id;
                        return id && UUID_RE.test(id) ? id : null;
                    },
                    setTitle: (s, v) => {
                        s.title = v;
                    },
                    setOverview: (s, v) => {
                        s.overview = v;
                    },
                });
                // Pass 2 — the parent-series NAME, keyed by the SERIES id. The
                // widget composes its label as `seriesName · SxxExx`, so
                // without this an episode renders a translated episode title
                // under an untranslated series name. `seriesId` is a UUID on
                // the local-session path and a Jellyfin id on others; the guard
                // simply skips the latter rather than issuing a dead lookup.
                await applyTranslationOverlay(sql, sessions, langs, {
                    id: (s) => (s.seriesId && UUID_RE.test(s.seriesId) ? s.seriesId : null),
                    setTitle: (s, v) => {
                        s.seriesName = v;
                    },
                });
            }
        } catch (error) {
            // Never fail the widget over a translation lookup — serve as-is.
            logger.debug('Active-streams translation overlay failed; serving primary language', {
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    // Watch-party overlay: tag rows that are one party's participants so the
    // widget can fold them into one card. Runs LAST, on the already privacy-
    // filtered rows, so it can only annotate what this viewer may see — and it
    // is per-viewer (private parties group only for participants/admins),
    // which the cache key already covers via userId + admin. Fail-soft.
    if (features.watchTogether && sessions.length > 0) {
        try {
            const [
                { getPartyStreamSnapshots },
                { annotateStreamsWithParties },
                { isWidgetDisabled },
            ] = await Promise.all([
                import('./watch-together.service.js'),
                import('./watch-party-stream-overlay.js'),
                import('../utils/widget-guard.js'),
            ]);
            const parties = await getPartyStreamSnapshots();
            sessions = annotateStreamsWithParties(sessions, parties, {
                userId: viewer.userId,
                username: viewer.username,
                isAdmin,
                publicListingEnabled: !isWidgetDisabled('watch-parties'),
            });
        } catch (error) {
            logger.debug('Active-streams watch-party overlay failed; serving ungrouped', {
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    const audiobookIds = sessions
        .filter((session) => session.mediaType === 'audiobook')
        .map((session) => getExternalIdFor(session.externalIds, 'internal') ?? session.mediaItemId)
        .filter((id): id is string => !!id);
    const artworkSql = getDb();
    const audiobookRevisions = artworkSql
        ? await getAudiobookImageRevisions(artworkSql, audiobookIds)
        : new Map<string, string>();
    sessions = sessions.map((session) => {
        if (session.mediaType !== 'audiobook') return session;
        const id = getExternalIdFor(session.externalIds, 'internal') ?? session.mediaItemId;
        const { imageId: _imageId, ...rest } = session;
        return {
            ...rest,
            images:
                id && audiobookRevisions.has(id)
                    ? audiobookImageSet('internal', id, audiobookRevisions.get(id)!)
                    : (session.images ?? {}),
        };
    });

    return {
        sessions,
        cacheTimestamp: sessionResult.cacheTimestamp ?? Date.now(),
        visible: true,
    };
}
