// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * User Section Feedback Query Module
 *
 * Tracks per-user, per-section-type engagement counters for the For-You
 * page ranker telemetry groundwork (migration 12.57.0). The counters are
 * accumulated across requests; no per-item granularity is stored here.
 *
 * The ranker — when it is eventually implemented — reads via getFeedback()
 * to produce a personalised section ordering. Until then these rows are
 * write-only from the application's perspective.
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';

// =============================================================================
// Types
// =============================================================================

export type FeedbackEvent = 'impression' | 'play' | 'abandon' | 'dismiss';

export interface FeedbackRow {
    sectionType: string;
    impressions: number;
    plays: number;
    abandonments: number;
    dismissals: number;
    lastEngagedAt: Date | null;
    updatedAt: Date;
}

// =============================================================================
// Write queries
// =============================================================================

/**
 * Atomically increment the counter for `event` in the user's section-feedback
 * row. Creates the row on first use via ON CONFLICT upsert.
 *
 * `last_engaged_at` is set to NOW() only for play / abandon / dismiss (i.e.
 * events that imply deliberate engagement). Impression events leave
 * `last_engaged_at` untouched so a glance-and-scroll does not inflate the
 * engagement timestamp used by the future ranker.
 *
 * `updated_at` is refreshed on every event (heartbeat for the ranker).
 */
export async function bumpFeedback(
    sql: postgres.Sql,
    params: { userId: UserId; sectionType: string; event: FeedbackEvent },
): Promise<void> {
    const { userId, sectionType, event } = params;

    await sql`
        INSERT INTO user_section_feedback (
            user_id,
            section_type,
            impressions,
            plays,
            abandonments,
            dismissals,
            last_engaged_at,
            updated_at
        ) VALUES (
            ${userId},
            ${sectionType},
            ${event === 'impression' ? 1 : 0},
            ${event === 'play' ? 1 : 0},
            ${event === 'abandon' ? 1 : 0},
            ${event === 'dismiss' ? 1 : 0},
            ${event !== 'impression' ? sql`NOW()` : sql`NULL`},
            NOW()
        )
        ON CONFLICT (user_id, section_type) DO UPDATE SET
            impressions  = user_section_feedback.impressions  + CASE WHEN ${event} = 'impression' THEN 1 ELSE 0 END,
            plays        = user_section_feedback.plays        + CASE WHEN ${event} = 'play'       THEN 1 ELSE 0 END,
            abandonments = user_section_feedback.abandonments + CASE WHEN ${event} = 'abandon'    THEN 1 ELSE 0 END,
            dismissals   = user_section_feedback.dismissals   + CASE WHEN ${event} = 'dismiss'    THEN 1 ELSE 0 END,
            last_engaged_at = CASE
                WHEN ${event} = 'impression' THEN user_section_feedback.last_engaged_at
                ELSE NOW()
            END,
            updated_at = NOW()
    `;
}

// =============================================================================
// Read queries
// =============================================================================

/**
 * Return all section-feedback rows for a user, keyed by section_type.
 * Used by the future ranker to determine per-section engagement scores.
 */
export async function getFeedback(
    sql: postgres.Sql,
    userId: UserId,
): Promise<Map<string, FeedbackRow>> {
    const rows = await sql<
        {
            section_type: string;
            impressions: number;
            plays: number;
            abandonments: number;
            dismissals: number;
            last_engaged_at: Date | null;
            updated_at: Date;
        }[]
    >`
        SELECT
            section_type,
            impressions,
            plays,
            abandonments,
            dismissals,
            last_engaged_at,
            updated_at
        FROM user_section_feedback
        WHERE user_id = ${userId}
    `;

    const map = new Map<string, FeedbackRow>();
    for (const row of rows) {
        map.set(row.section_type, {
            sectionType: row.section_type,
            impressions: row.impressions,
            plays: row.plays,
            abandonments: row.abandonments,
            dismissals: row.dismissals,
            lastEngagedAt: row.last_engaged_at,
            updatedAt: row.updated_at,
        });
    }
    return map;
}
