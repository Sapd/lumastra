// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Activity Feed Module
 *
 * Admin activity history including:
 * - Playback sessions (started, finished, abandoned)
 * - Watchlist changes (add, remove)
 * - Ratings
 * - Device, client, network, and playback diagnostics
 *
 * Usage:
 * ```svelte
 * <script>
 *   import { ActivityFeed } from '$lib/components/activity-feed';
 * </script>
 *
 * <ActivityFeed limit={50} />
 * ```
 */

// Main component
export { default as ActivityFeed } from './ActivityFeed.svelte';

// Sub-components (for custom layouts if needed)
export { default as ActivityRow } from './ActivityRow.svelte';
export { default as ActivityDetail } from './ActivityDetail.svelte';

// Utilities and types
export {
    type ActivityItem as ActivityItemType,
    type ActivityType,
    type ActivityFeedResponse,
    getActivityIcon,
    getActivityColor,
    getActivityVerb,
    getSubtitle,
    groupByDay,
    formatDayHeading,
    getDisplayTitle,
    formatMessage,
    formatBitrate,
    isViewingActivity,
} from './activity-utils';
