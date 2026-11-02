// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Manual file → episode links: windows an admin sets by hand.
 *
 * Some files hold episodes that no filename range can describe: reversed
 * (`S09E20-21` holds 9x20 then 9x19), not adjacent (9x37 + 9x41) or from two
 * seasons (11x16 + 10x19). An admin links such a file to an ordered list of
 * episodes and gives each one a window. The links carry
 * `media_file_items.offset_source = 'manual'`, which tells the segment refresh,
 * the scanner's range repair and the default-version promotion to leave them
 * alone (see file-segments.queries.ts).
 *
 * Shared by the admin editor (proposals while editing) and the server
 * (validation before anything is written), so both apply the same rules.
 */

/** `media_file_items.offset_source` of a link an admin set by hand. */
export const MANUAL_OFFSET_SOURCE = 'manual';

/** Shortest window accepted: anything shorter is a slip of the mouse. */
export const MIN_MANUAL_WINDOW_MS = 10_000;

/**
 * How far the last window may end from the probed duration. `duration_seconds`
 * is a `real`, so the stored duration is a rounded float; the server snaps the
 * last end to it.
 */
export const DURATION_SNAP_MS = 1_000;

export type BoundaryOrigin = 'manual' | 'chapter' | 'runtime-split' | 'even-split' | 'unknown';
export interface ManualWindow {
    boundaryOrigin?: BoundaryOrigin;
    /** Inclusive start offset within the file. */
    startMs: number;
    /** Exclusive end offset within the file. */
    endMs: number;
}

/**
 * Windows from the inner boundaries (`count - 1` start offsets after the
 * first episode). The first window starts at 0 and the last ends at EOF, so
 * the windows cover the file without gaps, like derived segments do.
 */
export function windowsFromBoundaries(durationMs: number, boundariesMs: number[]): ManualWindow[] {
    const starts = [0, ...boundariesMs];
    return starts.map((startMs, i) => ({
        startMs,
        endMs: i === starts.length - 1 ? durationMs : starts[i + 1],
    }));
}

/** Inner boundaries of an equal split into `count` windows. */
export function evenBoundaries(durationMs: number, count: number): number[] {
    const out: number[] = [];
    for (let i = 1; i < count; i++) out.push(Math.round((i * durationMs) / count));
    return out;
}

/**
 * Inner boundaries snapped to chapter starts: each even-split boundary moves to
 * the nearest chapter start that is later than the previous boundary. Returns
 * null when the file has too few chapters to give every boundary its own.
 */
export function chapterBoundaries(
    durationMs: number,
    count: number,
    chapterStartsMs: number[],
): number[] | null {
    const starts = [...new Set(chapterStartsMs)]
        .filter((s) => Number.isFinite(s) && s >= MIN_MANUAL_WINDOW_MS && s < durationMs)
        .sort((a, b) => a - b);
    const targets = evenBoundaries(durationMs, count);
    if (starts.length < targets.length) return null;

    const out: number[] = [];
    let from = 0;
    for (let i = 0; i < targets.length; i++) {
        // Leave enough chapters for the boundaries still to come.
        const last = starts.length - (targets.length - i);
        let best = from;
        for (let j = from; j <= last; j++) {
            if (Math.abs(starts[j] - targets[i]) < Math.abs(starts[best] - targets[i])) best = j;
        }
        out.push(starts[best]);
        from = best + 1;
    }
    return out;
}

/**
 * Check windows for `count` episodes against the file. Returns a message for the
 * admin, or null when they are usable. A single episode needs no window (the
 * whole file is the episode), so `windows` may be null only then.
 */
export function validateManualWindows(
    durationMs: number | null,
    count: number,
    windows: ManualWindow[] | null,
): string | null {
    if (count < 1) return 'Pick at least one episode.';
    if (windows === null) {
        return count === 1 ? null : 'Several episodes need a window each.';
    }
    if (windows.length !== count) return 'Give every episode exactly one window.';
    if (durationMs === null || !Number.isFinite(durationMs) || durationMs <= 0) {
        return 'The file has no probed duration yet. Probe it first.';
    }
    for (let i = 0; i < windows.length; i++) {
        const w = windows[i];
        if (!Number.isInteger(w.startMs) || !Number.isInteger(w.endMs)) {
            return 'Window bounds must be whole milliseconds.';
        }
        if (i === 0 && w.startMs !== 0) return 'The first window must start at 0:00.';
        if (i > 0 && w.startMs !== windows[i - 1].endMs) {
            return 'Each window must start where the previous one ends.';
        }
        if (w.endMs - w.startMs < MIN_MANUAL_WINDOW_MS) {
            return `Window ${i + 1} is shorter than ${MIN_MANUAL_WINDOW_MS / 1000} seconds.`;
        }
    }
    const lastEnd = windows[windows.length - 1].endMs;
    if (Math.abs(lastEnd - durationMs) > DURATION_SNAP_MS) {
        return 'The last window must end at the end of the file.';
    }
    return null;
}

/** Editable `m:ss` or `h:mm:ss`, retaining exact whole milliseconds. */
export function formatOffset(ms: number): string {
    if (!Number.isSafeInteger(ms) || ms < 0) return '—';
    const totalSec = Math.floor(ms / 1000);
    const frac = String(ms % 1000)
        .padStart(3, '0')
        .replace(/0+$/, '');
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const ss = `${String(s).padStart(2, '0')}${frac ? `.${frac}` : ''}`;
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Parse `m:ss`, `h:mm:ss` or plain seconds (decimals allowed) into ms; null when unreadable. */
export function parseOffset(text: string): number | null {
    const parts = text.trim().split(':');
    if (parts.length === 0 || parts.length > 3) return null;
    if (!parts.every((p, i) => (i === parts.length - 1 ? /^\d+(\.\d+)?$/ : /^\d+$/).test(p))) {
        return null;
    }
    const nums = parts.map(Number);
    if (nums.slice(1).some((n) => n >= 60)) return null;
    const seconds = nums.reduce((acc, n) => acc * 60 + n, 0);
    const ms = Math.round(seconds * 1000);
    return Number.isSafeInteger(ms) ? ms : null;
}
