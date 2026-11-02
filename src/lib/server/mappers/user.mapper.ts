// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

export interface UserRow {
    id: string;
    username: string;
    is_admin: boolean;
    admin_pinned: boolean;
    max_age_rating: number | null;
    age_rating_pinned: boolean;
    allow_live_tv?: boolean | null;
    display_name: string | null;
    email: string | null;
    hide_streams: boolean;
    groups: string[] | null;
    groups_updated_at: Date | null;
    created_at: Date;
    last_seen_at: Date | null;
    disabled_at: Date | null;
    // The fields below are populated only by the richer admin-user queries that
    // JOIN the AI profile / ratings / identity tables. Base-table reads such as
    // getUserById()/listUsers() omit them, so they are optional — mapUserToApi
    // already defaults each one when absent. Keeping them optional lets a plain
    // users.queries.UserRow flow into this mapper without a cross-type cast.
    has_native_password?: boolean | null;
    has_profile?: boolean | null;
    total_ratings?: number | string | null;
    current_ratings?: number | string | null;
    active_suggestions?: number | string | null;
    last_activity?: Date | null;
    identity_providers?: string[];
    /** Whether the user has an ACTIVE or PAUSED play_sessions row right now. */
    currently_streaming?: boolean;
    /** Most recent play_sessions activity (GREATEST(started_at, last_heartbeat_at)). */
    last_activity_at?: Date | null;
    /** Title of the media from the user's most recent play_sessions row. */
    last_watched_title?: string | null;
    /** `play_sessions.source` of that most recent row ('lumastra', 'jellyfin', …). */
    last_activity_source?: string | null;
    /** Whether a Jellyfin user id is cached for this account (it exists on the upstream server). */
    jellyfin_linked?: boolean;
    /** Live (unrevoked, unexpired) personal access + act-as service tokens. */
    api_token_count?: number;
}

// ApiUser is the single-source-of-truth Zod shape in api-user-responses.ts;
// re-export it so existing importers (mappers/index.ts) keep working while the
// response schema and this mapper's return type stay one declaration.
export type { ApiUser } from '$lib/schemas/api-user-responses.js';
import type { ApiUser } from '$lib/schemas/api-user-responses.js';

function toNumber(v: number | string | null | undefined): number | undefined {
    if (v == null) return undefined;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
}

/**
 * Map a user DB row (with joined AI profile data) to API response shape.
 */
export function mapUserToApi(row: UserRow): ApiUser {
    return {
        id: row.id,
        username: row.username,
        isAdmin: row.is_admin,
        adminPinned: row.admin_pinned,
        maxAgeRating: row.max_age_rating,
        ageRatingPinned: row.age_rating_pinned,
        allowLiveTv: row.allow_live_tv !== false,
        liveTvDefault: row.allow_live_tv == null,
        displayName: row.display_name ?? undefined,
        email: row.email ?? undefined,
        hideStreams: row.hide_streams,
        groups: row.groups,
        groupsUpdatedAt: row.groups_updated_at?.toISOString() ?? undefined,
        createdAt: row.created_at.toISOString(),
        lastSeenAt: row.last_seen_at?.toISOString() ?? undefined,
        disabled: row.disabled_at !== null,
        hasNativePassword: row.has_native_password ?? false,
        hasProfile: row.has_profile ?? undefined,
        totalRatings: toNumber(row.total_ratings),
        currentRatings: toNumber(row.current_ratings),
        activeSuggestions: toNumber(row.active_suggestions),
        lastActivity: row.last_activity?.toISOString() ?? undefined,
        identityProviders: row.identity_providers ?? [],
        currentlyStreaming: row.currently_streaming ?? false,
        lastActivityAt: row.last_activity_at?.toISOString() ?? undefined,
        lastWatchedTitle: row.last_watched_title ?? undefined,
        lastActivitySource: row.last_activity_source ?? undefined,
        jellyfinLinked: row.jellyfin_linked ?? undefined,
        apiTokenCount: row.api_token_count ?? undefined,
    };
}
