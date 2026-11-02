// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pure helpers for the Live TV simple mode screens (web). The simple-mode
 * channels are the user's favorites in favorite order; the number a viewer
 * sees is the position, starting at 1.
 */

import { pickNowNext } from '$lib/shared/livetv-now-next';
import type { LiveTvNowNext, LiveTvStation, LiveTvAiring } from '$lib/schemas/livetv.js';

export interface SimpleChannel {
    /** 1-based channel number, as on a TV remote. */
    number: number;
    channel: LiveTvStation;
}

export interface NowNext {
    now?: LiveTvAiring;
    next?: LiveTvAiring;
}

/** Ids in order → numbered channels; ids the lineup does not offer are skipped. */
export function buildSimpleLineup(
    stationIds: readonly string[],
    channels: readonly LiveTvStation[],
): SimpleChannel[] {
    const byId = new Map(channels.map((c) => [c.id, c]));
    const out: SimpleChannel[] = [];
    for (const id of stationIds) {
        const channel = byId.get(id);
        if (channel) out.push({ number: out.length + 1, channel });
    }
    return out;
}

/**
 * The channel `delta` steps from `currentId`, wrapping around like a TV
 * (after the last comes the first). An unknown current channel steps from
 * "before the first", so +1 gives channel 1.
 */
export function stepChannel(
    lineup: readonly SimpleChannel[],
    currentId: string | undefined,
    delta: number,
): SimpleChannel | undefined {
    if (lineup.length === 0) return undefined;
    const index = lineup.findIndex((c) => c.channel.id === currentId);
    const from = index === -1 ? (delta > 0 ? -1 : 0) : index;
    const n = lineup.length;
    return lineup[(((from + delta) % n) + n) % n];
}

export function findByNumber(
    lineup: readonly SimpleChannel[],
    num: number,
): SimpleChannel | undefined {
    return lineup.find((c) => c.number === num);
}

/** The channel to open with: the remembered one, else the start channel, else channel 1. */
export function pickStartChannel(
    lineup: readonly SimpleChannel[],
    startStationId: string | undefined,
    lastWatchedId?: string | null,
): SimpleChannel | undefined {
    return (
        lineup.find((c) => c.channel.id === lastWatchedId) ??
        lineup.find((c) => c.channel.id === startStationId) ??
        lineup[0]
    );
}

/**
 * Now and next for one channel from guide programs (any order). Falls back to
 * the station's own `nowNext`. Nothing → both undefined, and
 * the screens hide the rows instead of saying "No information".
 */
export function nowNext(
    programs: readonly LiveTvAiring[] | undefined,
    nowMs: number,
    fallback?: LiveTvNowNext,
): NowNext {
    const fallbackAirings = fallback
        ? [fallback.current, fallback.next].filter((p): p is LiveTvAiring => p !== null)
        : [];
    let selected = pickNowNext(programs ?? [], nowMs);
    if (!selected.current) {
        const byId = new Map([...(programs ?? []), ...fallbackAirings].map((p) => [p.id, p]));
        selected = pickNowNext([...byId.values()], nowMs);
    }
    return { now: selected.current ?? undefined, next: selected.next ?? undefined };
}

/** 0..100, how far the programme has run. */
export function progressPercent(program: LiveTvAiring, nowMs: number): number {
    const start = Date.parse(program.startTime);
    const end = Date.parse(program.endTime);
    if (!(end > start)) return 0;
    return Math.min(100, Math.max(0, ((nowMs - start) / (end - start)) * 100));
}

/**
 * Background colours for the number disc of a channel without a logo. Every
 * one keeps white text at 7:1 or better (WCAG AAA).
 */
export const DISC_COLORS = [
    '#1e3a8a', // blue 900
    '#7f1d1d', // red 900
    '#14532d', // green 900
    '#581c87', // purple 900
    '#7c2d12', // orange 900
    '#134e4a', // teal 900
    '#831843', // pink 900
    '#312e81', // indigo 900
] as const;

/** Up to two letters for a logo-less channel: "Kanal Sieben" → "KS", "Nordwelle" → "NO". */
export function initials(name: string): string {
    const words = name.split(/[\s\-_.]+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
    if (words.length === 0) return '?';
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
}

/** Same name → same colour, on every device. */
export function discColor(name: string): string {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
    return DISC_COLORS[Math.abs(hash) % DISC_COLORS.length];
}

export function lastWatchedKey(username: string | undefined): string {
    return `lumastra:livetv-simple:last:${username ?? ''}`;
}

export function readLastWatched(username: string | undefined): string | null {
    try {
        return localStorage.getItem(lastWatchedKey(username));
    } catch {
        return null;
    }
}

export function writeLastWatched(username: string | undefined, channelId: string): void {
    try {
        localStorage.setItem(lastWatchedKey(username), channelId);
    } catch {
        // Storage blocked: the start channel is used next time.
    }
}

/** The TV layout jumps to the picture once per browser session. */
export const AUTOSTART_SESSION_KEY = 'lumastra:livetv-simple:autostarted';
