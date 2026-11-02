// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pure overlay primitives for the Top Shelf overlay burn-in feature:
 * style normalization, the signed variant-token grammar, and the
 * overlay-content hash. No IO — unit-testable in isolation.
 */

import { createHash } from 'node:crypto';

export type OverlayMode = 'logo' | 'text' | 'none';
export type OverlayPosition = 'tl' | 'tr' | 'bl' | 'br';

export interface OverlayStyle {
    pos: OverlayPosition;
    scrim: boolean;
    scale: number;
}

/** Overlay content modes that actually burn something (excludes 'none'). */
export type OverlayBurnMode = 'logo' | 'text';
export type OverlayBaseVariant = 'preview' | 'cinemagraph';

/**
 * Fraction of the BASE FRAME HEIGHT the overlay box may occupy.
 *
 * The overlay used to be sized by WIDTH ONLY (`scale * maxWidth`, height `-1`),
 * which left the burned block's height entirely at the mercy of the content
 * PNG's intrinsic aspect: a stacked/near-square logo composite scaled to 40% of
 * the frame width came out ~88% of the frame HEIGHT (measured), and a
 * chip-dominated canvas reached 147% — i.e. it ran clean off the frame, taking
 * the `S01E02` badge (which scaled by the same factor) with it.
 *
 * Bounding the box in BOTH axes is what makes that structurally impossible.
 * 0.26 keeps a 16:9 frame's overlay block to about a quarter of its height —
 * enough that a wide wordmark still fills the box's width and a stacked logo
 * stays readable, while the whole burn reads as "a corner badge" rather than
 * "a title card".
 */
export const OVERLAY_BOX_HEIGHT_FRACTION = 0.26;

/**
 * The fixed, absolute-pixel box the overlay content is composited into.
 *
 * `baseWidth`/`baseHeight` are the dimensions the OVERLAY PATH forces the base
 * video to (`[0:v]scale=maxWidth:-2`, sized against a 16:9-ish reference — the
 * same reference the scrim band already uses). Every consumer derives the
 * same box from the same inputs (`style.scale`, `TOPSHELF_RENDER_MAX_WIDTH`/
 * `TOPSHELF_RENDER_MAX_HEIGHT`), so the PNG materializer and the ffmpeg graph
 * agree by construction rather than by convention.
 */
export interface OverlayBox {
    baseWidth: number;
    baseHeight: number;
    /** Content box width in px — the style's scale fraction of the base width. */
    boxW: number;
    /** Content box height in px — {@link OVERLAY_BOX_HEIGHT_FRACTION} of the base height. */
    boxH: number;
}

/**
 * Compute the overlay content box in absolute pixels. Pure: `maxWidth` is
 * passed in (normally `config.TOPSHELF_RENDER_MAX_WIDTH`) so this module
 * stays IO/config-free and unit-testable.
 *
 * `maxHeight` (normally `config.TOPSHELF_RENDER_MAX_HEIGHT`) is the height the
 * overlay path cover-crops the base video to, so the box is computed against
 * the real frame. When omitted, falls back to a 16:9
 * assumption derived from `maxWidth` (pre-existing behavior, kept for callers
 * that don't have a configured height, e.g. tests exercising the box formula
 * in isolation).
 */
export function computeOverlayBox(scale: number, maxWidth: number, maxHeight?: number): OverlayBox {
    const baseWidth = Math.max(1, Math.round(maxWidth));
    const baseHeight = Math.max(
        1,
        Math.round(maxHeight !== undefined ? maxHeight : (baseWidth * 9) / 16),
    );
    return {
        baseWidth,
        baseHeight,
        boxW: Math.max(1, Math.round(scale * baseWidth)),
        boxH: Math.max(1, Math.round(OVERLAY_BOX_HEIGHT_FRACTION * baseHeight)),
    };
}

const POSITIONS: readonly OverlayPosition[] = ['tl', 'tr', 'bl', 'br'];
export const OVERLAY_ALLOWED_SCALES: readonly number[] = [0.25, 0.33, 0.4, 0.5];

function isPosition(v: string): v is OverlayPosition {
    return (POSITIONS as readonly string[]).includes(v);
}

function snapScale(value: number, allowed: readonly number[]): number {
    let best = allowed[0];
    let bestDelta = Math.abs(value - best);
    for (const a of allowed) {
        const d = Math.abs(value - a);
        if (d < bestDelta) {
            best = a;
            bestDelta = d;
        }
    }
    return best;
}

export function normalizeOverlayStyle(
    raw: { pos?: string; scrim?: string | boolean; scale?: string | number },
    defaults: OverlayStyle,
): OverlayStyle {
    const rawPos = typeof raw.pos === 'string' ? raw.pos.trim().toLowerCase() : '';
    const pos = isPosition(rawPos) ? rawPos : defaults.pos;

    let scrim = defaults.scrim;
    if (typeof raw.scrim === 'boolean') scrim = raw.scrim;
    else if (raw.scrim === '1') scrim = true;
    else if (raw.scrim === '0') scrim = false;

    // ALWAYS snap through the allowed-scale grid — including the
    // default-fallback path. Otherwise a misconfigured
    // `TOPSHELF_OVERLAY_DEFAULT_SCALE` sitting off the grid (e.g. 1.0) flows
    // straight into the token unsnapped, and `parseOverlayToken` rejects any
    // scaleInt not in `OVERLAY_ALLOWED_SCALES` — permanently unparseable.
    const scaleNum = typeof raw.scale === 'number' ? raw.scale : Number.parseFloat(raw.scale ?? '');
    const effectiveScale = Number.isFinite(scaleNum) ? scaleNum : defaults.scale;
    const scale = snapScale(effectiveScale, OVERLAY_ALLOWED_SCALES);

    return { pos, scrim, scale };
}

/** `[a-z]{2}` primary-subtag entries only — the sole shape `parseOverlayToken` accepts. */
const SAFE_LOCALE_RE = /^[a-z]{2}$/;

function toSafePrimarySubtag(v: string): string | null {
    const primary = v.toLowerCase().split(/[-_]/)[0];
    return SAFE_LOCALE_RE.test(primary) ? primary : null;
}

export function normalizeOverlayLocale(
    raw: string | null | undefined,
    allowList: readonly string[],
): string {
    // Reduce the configured allow-list to its token-safe primary subtags
    // first — an allow-list entry like `de-at` or `zh-hans` must never leak
    // into the minted token verbatim: `parseOverlayToken`'s regex only
    // accepts `[a-z]{2}`, so an unsafe entry would mint a token that can
    // never be parsed back → every serve 422s. `'en'` is the last-resort
    // fallback when the whole configured list is unusable.
    const safeAllowList = new Set(
        allowList.map(toSafePrimarySubtag).filter((v): v is string => v !== null),
    );
    const fallback = safeAllowList.size > 0 ? [...safeAllowList][0] : 'en';

    const primary = raw ? toSafePrimarySubtag(raw) : null;
    return primary && safeAllowList.has(primary) ? primary : fallback;
}

function scaleInt(scale: number): number {
    return Math.round(scale * 100);
}

export function serializeOverlayToken(
    base: OverlayBaseVariant,
    mode: OverlayBurnMode,
    style: OverlayStyle,
    locale?: string,
): string {
    const localePart = mode === 'text' && locale ? `-${locale}` : '';
    return `${base}-ov-${mode}${localePart}-${style.pos}-s${style.scrim ? 1 : 0}-x${scaleInt(style.scale)}`;
}

export interface ParsedOverlayToken {
    base: OverlayBaseVariant;
    mode: OverlayBurnMode;
    style: OverlayStyle;
    locale?: string;
}

const TOKEN_RE =
    /^(preview|cinemagraph)-ov-(logo|text)(?:-([a-z]{2}))?-(tl|tr|bl|br)-s([01])-x(\d{2,3})$/;

export function parseOverlayToken(token: string): ParsedOverlayToken | null {
    const m = TOKEN_RE.exec(token);
    if (!m) return null;
    const [, base, mode, locale, pos, scrim, scaleStr] = m;
    // logo tokens must not carry a locale; text tokens must.
    if (mode === 'logo' && locale) return null;
    if (mode === 'text' && !locale) return null;
    const scale = Number.parseInt(scaleStr, 10) / 100;
    if (!OVERLAY_ALLOWED_SCALES.includes(scale)) return null;
    const parsed: ParsedOverlayToken = {
        base: base as OverlayBaseVariant,
        mode: mode as OverlayBurnMode,
        style: { pos: pos as OverlayPosition, scrim: scrim === '1', scale },
    };
    if (mode === 'text') parsed.locale = locale;
    return parsed;
}

/**
 * Hash of WHAT gets burned, for the content key.
 *
 * `badge` (logo mode only — the small `S01E02` chip composited under an
 * episode's inherited series logo) is folded in ONLY when present, so a plain
 * logo overlay keeps the exact hash it had before badges existed and no
 * already-rendered movie/series artifact is invalidated. When a badge IS
 * present it must participate: an episode renumber (S01E02 → S01E03) changes
 * nothing else about the logo identity, yet must rotate the artifact.
 */
export function computeOverlayContentHash(
    input: { mode: 'logo'; identity: string; badge?: string } | { mode: 'text'; text: string },
): string {
    const canonical =
        input.mode === 'logo'
            ? input.badge
                ? `logo:${input.identity}|badge:${input.badge}`
                : `logo:${input.identity}`
            : `text:${input.text}`;
    return createHash('sha1').update(canonical).digest('hex').slice(0, 16);
}
