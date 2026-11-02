// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { Clock, PlayCircle, CheckCircle, PauseCircle, Plus, Minus, Star } from 'svelte-hero-icons';
import type { IconSource } from 'svelte-hero-icons';
import type {
    ActivityFeedEntry,
    ActivityFeedResponse,
    ActivityType,
} from '$lib/schemas/activity-feed';
import { displayName } from '$lib/utils/data-extraction';

export type ActivityItem = ActivityFeedEntry;
export type { ActivityFeedResponse, ActivityType };

export function getActivityIcon(type: ActivityType | string): IconSource {
    switch (type) {
        case 'started':
            return PlayCircle;
        case 'finished':
            return CheckCircle;
        case 'abandoned':
            return PauseCircle;
        case 'watchlist_add':
            return Plus;
        case 'watchlist_remove':
            return Minus;
        case 'rating':
            return Star;
        default:
            return Clock;
    }
}

export function getActivityColor(type: ActivityType | string): string {
    switch (type) {
        case 'started':
            return 'text-blue-400';
        case 'finished':
            return 'text-green-400';
        case 'abandoned':
            return 'text-yellow-400';
        case 'watchlist_add':
            return 'text-purple-400';
        case 'watchlist_remove':
            return 'text-red-400';
        case 'rating':
            return 'text-amber-400';
        default:
            return 'text-surface-400';
    }
}

export function getDisplayTitle(activity: ActivityItem): string {
    if (activity.seriesName && activity.seasonNumber !== null && activity.episodeNumber !== null) {
        return `${activity.seriesName} S${activity.seasonNumber}E${activity.episodeNumber} · ${activity.title}`;
    }
    return activity.title;
}

export function formatMessage(activity: ActivityItem): string {
    const user = displayName((activity.author.displayName ?? '') || activity.author.userId);
    const title = getDisplayTitle(activity);

    switch (activity.activityType) {
        case 'started':
            return `${user} started ${title}`;
        case 'finished':
            return `${user} finished ${title}`;
        case 'abandoned':
            return `${user} stopped ${title}`;
        case 'watchlist_add':
            return `${user} added ${title} to their watchlist`;
        case 'watchlist_remove':
            return `${user} removed ${title} from their watchlist`;
        case 'rating':
            return `${user} rated ${title}${activity.ratingValue === null ? '' : ` ${activity.ratingValue}/10`}`;
        default:
            return `${user} ${activity.activityType} ${title}`;
    }
}

export function formatBitrate(bitrate: number): string {
    const mbps = bitrate / 1_000_000;
    return mbps >= 1 ? `${mbps.toFixed(1)} Mbps` : `${(bitrate / 1_000).toFixed(0)} Kbps`;
}

export function isViewingActivity(activity: ActivityItem): boolean {
    return ['started', 'finished', 'abandoned'].includes(activity.activityType);
}

/** Short verb for the row's status label ("Stopped", "Rated 8/10", …). */
export function getActivityVerb(activity: ActivityItem): string {
    switch (activity.activityType) {
        case 'started':
            return activity.isActive ? 'Watching' : 'Started';
        case 'finished':
            return 'Finished';
        case 'abandoned':
            return 'Stopped';
        case 'watchlist_add':
            return 'Watchlisted';
        case 'watchlist_remove':
            return 'Unwatchlisted';
        case 'rating':
            return activity.ratingValue === null ? 'Rated' : `Rated ${activity.ratingValue}/10`;
        default:
            return activity.activityType;
    }
}

/** Secondary title line: "S1E2 · Series" for episodes, "movie · 1922" otherwise. */
export function getSubtitle(activity: ActivityItem): string {
    if (activity.seriesName && activity.seasonNumber !== null && activity.episodeNumber !== null) {
        return `${activity.seriesName} · S${activity.seasonNumber}E${activity.episodeNumber}`;
    }
    return [activity.mediaType, activity.year].filter((part) => part !== null).join(' · ');
}

export function labelPlayMethod(value: string): string {
    return value.replaceAll('_', ' ').replace(/^\w/, (letter) => letter.toUpperCase());
}

/**
 * Badge class for the play method: direct play/stream is the healthy path
 * (green), anything that re-encodes costs the server (yellow).
 */
export function playMethodBadge(value: string): string {
    return value.includes('transcode') ? 'badge-soft-yellow' : 'badge-soft-green';
}

export function getProgress(activity: ActivityItem): number | null {
    const value = activity.currentProgressPercentage ?? activity.completionPercentage;
    return value === null ? null : Math.min(100, Math.max(0, value));
}

/** Local calendar-day key (YYYY-MM-DD) used to group the feed by day. */
export function dayKey(iso: string): string {
    const date = new Date(iso);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
}

export function formatDayHeading(iso: string, now: Date = new Date()): string {
    const key = dayKey(iso);
    if (key === dayKey(now.toISOString())) return 'Today';
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (key === dayKey(yesterday.toISOString())) return 'Yesterday';
    const date = new Date(iso);
    return date.toLocaleDateString(undefined, {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
    });
}

export function groupByDay(items: ActivityItem[]): { key: string; items: ActivityItem[] }[] {
    const groups: { key: string; items: ActivityItem[] }[] = [];
    for (const item of items) {
        const key = dayKey(item.activityTime);
        const last = groups.at(-1);
        if (last?.key === key) last.items.push(item);
        else groups.push({ key, items: [item] });
    }
    return groups;
}
