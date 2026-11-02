// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type {
    AdaptiveTier,
    AdaptiveVariant,
    SessionAdaptive,
} from '$lib/schemas/session-adaptive.js';
import type { ProxyEncoderInfo } from '$lib/schemas/livetv.js';
import * as m from '$lib/paraglide/messages.js';

/** "4 Mbps", "2.5 Mbps", "800 kbps". */
export function formatAbrBitrate(bps: number): string {
    if (bps >= 1_000_000) {
        const mbps = bps / 1_000_000;
        const value = mbps >= 10 ? Math.round(mbps).toString() : String(Math.round(mbps * 10) / 10);
        return m.sessions_abr_mbps({ value });
    }
    return m.sessions_abr_kbps({ value: String(Math.max(1, Math.round(bps / 1000))) });
}

/** "720p", "Original", or the raw id for a variant we know nothing about. */
export function variantName(variant: AdaptiveVariant): string {
    if (variant.original) return m.livetv_quality_status_original();
    if (variant.height) return `${variant.height}p`;
    return variant.id;
}

/** "720p · 4 Mbps" — the badge text and ladder rows. */
export function variantLabel(variant: AdaptiveVariant): string {
    const name = variantName(variant);
    return variant.bitrate ? `${name} · ${formatAbrBitrate(variant.bitrate)}` : name;
}

/** The badge colours of the web player's ladder badge (PlayerOverlay `.abr-*`). */
export function adaptiveTierClass(tier: AdaptiveTier | undefined): string {
    switch (tier) {
        case 'top':
            return 'bg-[rgba(46,204,113,0.9)] text-white';
        case 'low':
            return 'bg-[rgba(245,158,11,0.9)] text-[#333]';
        case 'bottom':
            return 'bg-[rgba(239,68,68,0.9)] text-white';
        default:
            // 'high', and teal until the playing variant is known.
            return 'bg-[rgba(20,184,166,0.9)] text-white';
    }
}

export function adaptiveBadgeText(adaptive: SessionAdaptive): string {
    return adaptive.current
        ? m.player_abr_badge_current({ quality: variantLabel(adaptive.current) })
        : m.player_abr_badge();
}

/** Multi-line tooltip: the ladder with the playing variant marked, then the counters. */
export function adaptiveTooltip(adaptive: SessionAdaptive): string {
    const lines: string[] = [m.player_tt_abr_title()];
    for (const variant of adaptive.ladder) {
        const playing = adaptive.current?.id === variant.id;
        lines.push(
            `${playing ? '▶ ' : '   '}${variantLabel(variant)}${playing ? ` (${m.player_tt_abr_playing()})` : ''}`,
        );
    }
    const stats = adaptiveStats(adaptive);
    if (stats.length > 0) lines.push(stats.join(' · '));
    return lines.join('\n');
}

/** "3 switches", "Measured bandwidth 24 Mbps", "1 stall" — whatever is known. */
export function adaptiveStats(adaptive: SessionAdaptive): string[] {
    const stats: string[] = [];
    if (adaptive.switches !== undefined)
        stats.push(m.sessions_abr_switches({ count: String(adaptive.switches) }));
    if (adaptive.measuredBandwidth)
        stats.push(
            m.sessions_abr_bandwidth({ value: formatAbrBitrate(adaptive.measuredBandwidth) }),
        );
    if (adaptive.rebuffers !== undefined)
        stats.push(m.sessions_abr_rebuffers({ count: String(adaptive.rebuffers) }));
    return stats;
}

/** The ladder name of a rung id from a switch record ("720p4m" → "720p"). */
export function rungIdName(adaptive: SessionAdaptive, id: string): string {
    const variant = adaptive.ladder.find((v) => v.id === id);
    return variant
        ? variantName(variant)
        : id === 'original'
          ? m.livetv_quality_status_original()
          : id;
}

/** The channel's adaptive encoder group, from the proxy status the admin page polls. */
export function adaptiveEncoderFor(
    encoders: readonly ProxyEncoderInfo[] | undefined,
): ProxyEncoderInfo | null {
    return encoders?.find((enc) => enc.kind === 'adaptive' && !enc.stopping) ?? null;
}

/** "14:03". */
export function formatAbrTime(iso: string): string {
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
        ? ''
        : date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
