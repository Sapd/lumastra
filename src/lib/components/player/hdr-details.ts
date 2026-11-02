// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the HDR badge's hover card says: the source's real dynamic-range
 * format (down to the Dolby Vision profile), what actually reaches the
 * screen, and why the two differ.
 *
 * Pure: the overlay feeds it the store's hdrInfo, the play method and the
 * browser's probed capabilities, and renders the result.
 */

/** The HDR vocabulary of lumastra-info (`tracks.video.hdr` / `output_hdr`). */
export type HdrKey = 'dovi' | 'dovi_hdr10' | 'hdr10plus' | 'hdr10' | 'hlg' | 'sdr' | 'hdr';

export type DvBaseLayer = 'hdr10' | 'sdr' | 'hlg' | 'none';

/**
 * Accepts both the lumastra-info enum ('dovi_hdr10') and the short labels the
 * legacy direct-play path stores ('DV P8', 'HDR10+').
 */
export function normalizeHdrKey(raw: string | null | undefined): HdrKey | null {
    if (!raw) return null;
    const v = raw.trim();
    switch (v.toLowerCase()) {
        case 'dovi_hdr10':
        case 'dv p8':
        case 'dv hlg':
            return 'dovi_hdr10';
        case 'dovi':
        case 'dv':
        case 'dv p5':
        case 'dv p7':
            return 'dovi';
        case 'hdr10plus':
        case 'hdr10+':
            return 'hdr10plus';
        case 'hdr10':
            return 'hdr10';
        case 'hlg':
            return 'hlg';
        case 'sdr':
            return 'sdr';
        case 'hdr':
            return 'hdr';
        default:
            return null;
    }
}

export function isDvKey(key: HdrKey | null): boolean {
    return key === 'dovi' || key === 'dovi_hdr10';
}

/** DV base layer from the compatibility id (0 none, 1 HDR10, 2 SDR, 4 HLG). */
export function dvBaseLayer(key: HdrKey | null, compatId: number | undefined): DvBaseLayer | null {
    if (!isDvKey(key)) return null;
    switch (compatId) {
        case 0:
            return 'none';
        case 1:
            return 'hdr10';
        case 2:
            return 'sdr';
        case 4:
            return 'hlg';
        default:
            // Files probed before the compatibility id was captured: the enum
            // only says whether there is an HDR base layer.
            return key === 'dovi_hdr10' ? 'hdr10' : 'none';
    }
}

/**
 * "8.1", "7", "5". Profiles 8 and 10 carry the compatibility id as the
 * sub-profile (8.1 = HDR10 base, 8.2 = SDR base, 8.4 = HLG base).
 */
export function formatDvProfile(
    profile: number | undefined,
    compatId: number | undefined,
): string | null {
    if (profile === undefined) return null;
    if ((profile === 8 || profile === 10) && compatId !== undefined && compatId > 0) {
        return `${profile}.${compatId}`;
    }
    return String(profile);
}

/** Short badge label for one side of the conversion. */
export function shortHdrLabel(
    key: HdrKey | null,
    dvProfile?: number,
    dvCompatId?: number,
): string | null {
    if (!key) return null;
    if (isDvKey(key)) {
        const p = formatDvProfile(dvProfile, dvCompatId);
        if (p) return `DV P${p}`;
        // Unknown profile: say what the enum actually knows, not a guessed number.
        return 'DV';
    }
    switch (key) {
        case 'hdr10plus':
            return 'HDR10+';
        case 'hdr10':
            return 'HDR10';
        case 'hlg':
            return 'HLG';
        case 'sdr':
            return 'SDR';
        default:
            return 'HDR';
    }
}

/** Long name for the hover card. */
export function longHdrLabel(
    key: HdrKey | null,
    dvProfile?: number,
    dvCompatId?: number,
): string | null {
    if (!key) return null;
    if (isDvKey(key)) {
        const p = formatDvProfile(dvProfile, dvCompatId);
        return p ? `Dolby Vision Profile ${p}` : 'Dolby Vision';
    }
    return shortHdrLabel(key);
}

export interface HdrInfoInput {
    sourceFormat: string | null;
    outputFormat: string | null;
    isToneMapped: boolean;
    dvProfile?: number;
    dvBlCompatId?: number;
}

export interface HdrCapsInput {
    dolbyVision: boolean;
    hdr10: boolean;
    hdr10Plus: boolean;
    hlg: boolean;
    hdrDisplay: boolean;
}

/** Why the picture on screen is (or isn't) what the file holds. */
export type HdrOutcome =
    /** HDR/DV reaches the browser unchanged and the browser can decode it. */
    | 'passthrough'
    /** DV stream reaches the browser, but it can't decode DV: plays the base layer. */
    | 'dv_base_layer'
    /** Re-encode dropped the DV RPU; the HDR10/HLG base layer survives. */
    | 'dv_stripped'
    /** Re-encoded into a 10-bit codec with HDR kept. */
    | 'hdr_reencoded'
    /** Server tone-mapped HDR down to SDR. */
    | 'tonemapped';

export type TonemapCause = 'browser_no_hdr' | 'browser_no_dv' | 'codec_no_hdr' | 'other';

export interface HdrDetails {
    sourceKey: HdrKey;
    outputKey: HdrKey;
    sourceLabel: string;
    outputLabel: string;
    /** Only for DV sources. */
    baseLayer: DvBaseLayer | null;
    outcome: HdrOutcome;
    tonemapCause: TonemapCause | null;
    /** HDR output on a display that isn't in HDR mode: the OS/browser maps it down. */
    displaySdr: boolean;
}

export interface HdrDetailsContext {
    isVideoTranscode: boolean;
    /** e.g. 'h264', 'hevc' — the re-encode target, when known. */
    targetCodec?: string | null;
    caps: HdrCapsInput | null;
}

function browserDecodes(key: HdrKey, caps: HdrCapsInput): boolean {
    switch (key) {
        case 'dovi':
        case 'dovi_hdr10':
            return caps.dolbyVision;
        case 'hdr10plus':
            return caps.hdr10Plus || caps.hdr10;
        case 'hlg':
            return caps.hlg;
        case 'sdr':
            return true;
        default:
            return caps.hdr10;
    }
}

export function buildHdrDetails(info: HdrInfoInput, ctx: HdrDetailsContext): HdrDetails | null {
    const sourceKey = normalizeHdrKey(info.sourceFormat);
    if (!sourceKey || sourceKey === 'sdr') return null;

    // No output reported (legacy direct play) means the file plays as-is.
    const outputKey: HdrKey = info.isToneMapped
        ? 'sdr'
        : (normalizeHdrKey(info.outputFormat) ?? sourceKey);

    const baseLayer = dvBaseLayer(sourceKey, info.dvBlCompatId);
    const sourceLabel = longHdrLabel(sourceKey, info.dvProfile, info.dvBlCompatId) ?? sourceKey;
    // Output keeps the DV profile only when DV itself survives.
    const outputLabel =
        (isDvKey(outputKey)
            ? longHdrLabel(outputKey, info.dvProfile, info.dvBlCompatId)
            : longHdrLabel(outputKey)) ?? outputKey;

    let outcome: HdrOutcome;
    let tonemapCause: TonemapCause | null = null;
    if (outputKey === 'sdr') {
        outcome = 'tonemapped';
        const target = ctx.targetCodec?.toLowerCase();
        if (target === 'h264' || target === 'avc') tonemapCause = 'codec_no_hdr';
        else if (ctx.caps && isDvKey(sourceKey) && baseLayer === 'none' && !ctx.caps.dolbyVision)
            tonemapCause = 'browser_no_dv';
        else if (ctx.caps && !ctx.caps.hdr10 && !ctx.caps.hlg) tonemapCause = 'browser_no_hdr';
        else tonemapCause = 'other';
    } else if (isDvKey(sourceKey) && !isDvKey(outputKey)) {
        outcome = 'dv_stripped';
    } else if (ctx.isVideoTranscode) {
        outcome = 'hdr_reencoded';
    } else if (isDvKey(outputKey) && ctx.caps && !ctx.caps.dolbyVision) {
        outcome = 'dv_base_layer';
    } else {
        outcome = 'passthrough';
    }

    const displaySdr =
        outputKey !== 'sdr' &&
        ctx.caps !== null &&
        !ctx.caps.hdrDisplay &&
        browserDecodes(outcome === 'dv_base_layer' ? 'hdr10' : outputKey, ctx.caps);

    return {
        sourceKey,
        outputKey,
        sourceLabel,
        outputLabel,
        baseLayer,
        outcome,
        tonemapCause,
        displaySdr,
    };
}

/**
 * The badge text: the source, plus "→ output" whenever what plays differs
 * from the file (DV P8.1 → HDR10 on a re-encode, HDR10 → SDR on a tone-map).
 */
export function hdrBadgeLabel(info: HdrInfoInput): string | null {
    const sourceKey = normalizeHdrKey(info.sourceFormat);
    const source = shortHdrLabel(sourceKey, info.dvProfile, info.dvBlCompatId) ?? info.sourceFormat;
    if (!source) return null;
    const outputKey: HdrKey | null = info.isToneMapped ? 'sdr' : normalizeHdrKey(info.outputFormat);
    if (!outputKey || outputKey === sourceKey) return source;
    const output = isDvKey(outputKey)
        ? shortHdrLabel(outputKey, info.dvProfile, info.dvBlCompatId)
        : shortHdrLabel(outputKey);
    return `${source} → ${output}`;
}
