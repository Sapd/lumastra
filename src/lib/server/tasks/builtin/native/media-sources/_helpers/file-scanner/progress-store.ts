// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import {
    cacheGet,
    cacheSet,
    cacheDel,
    getKeysByPattern,
    isValkeyReady,
} from '$lib/server/cache/valkey';

export interface FileScannerProgress {
    totalFiles: number;
    processedFiles: number;
    currentFile: string;
    currentLibraryPath: string;
    added: number;
    updated: number;
    skipped: number;
    unmatched: number;
    errors: number;
    /** 'discovering' while the directory walk is in progress; 'scanning' once files are being processed. */
    phase?: 'discovering' | 'scanning';
}

const KEY_PREFIX = 'v1:file-scanner:progress:';
const PROGRESS_TTL_SECONDS = 600;

function key(scanKey: string): string {
    return `${KEY_PREFIX}${scanKey}`;
}

export async function setScanProgress(
    scanKey: string,
    progress: FileScannerProgress,
): Promise<void> {
    if (!isValkeyReady()) return;
    await cacheSet(key(scanKey), JSON.stringify(progress), PROGRESS_TTL_SECONDS);
}

export async function getScanProgress(scanKey: string): Promise<FileScannerProgress | null> {
    if (!isValkeyReady()) return null;
    const raw = await cacheGet(key(scanKey));
    if (!raw) return null;
    try {
        return JSON.parse(raw) as FileScannerProgress;
    } catch {
        return null;
    }
}

export async function deleteScanProgress(scanKey: string): Promise<void> {
    if (!isValkeyReady()) return;
    await cacheDel(key(scanKey));
}

export async function getAnyScanProgress(): Promise<FileScannerProgress | null> {
    if (!isValkeyReady()) return null;
    const keys = await getKeysByPattern(`${KEY_PREFIX}*`);
    if (keys.length === 0) return null;
    // Walk every key — bailing on the first null would hide live progress
    // if that single key expired between SCAN and GET.
    for (const k of keys) {
        const raw = await cacheGet(k);
        if (!raw) continue;
        try {
            return JSON.parse(raw) as FileScannerProgress;
        } catch {
            /* try next */
        }
    }
    return null;
}

/**
 * Every live scan's progress, keyed by its scan key (the library path id for a
 * per-path scan, 'all' for a legacy full scan). Same staleness filter as
 * {@link getAggregateScanProgress}.
 */
export async function getScanProgressByKey(): Promise<Map<string, FileScannerProgress>> {
    const out = new Map<string, FileScannerProgress>();
    if (!isValkeyReady()) return out;
    for (const k of await getKeysByPattern(`${KEY_PREFIX}*`)) {
        const raw = await cacheGet(k);
        if (!raw) continue;
        try {
            const entry = JSON.parse(raw) as FileScannerProgress;
            if (entry.totalFiles > 0 && entry.processedFiles >= entry.totalFiles) continue;
            out.set(k.slice(k.indexOf(KEY_PREFIX) + KEY_PREFIX.length), entry);
        } catch {
            /* skip malformed entry */
        }
    }
    return out;
}

/**
 * Read ALL active scan-progress keys and return an aggregated view.
 *
 * Sums totalFiles/processedFiles/added/updated/skipped/unmatched/errors
 * across every running scan so callers see coherent cluster-wide totals.
 * Phase is 'discovering' when any key is in that phase, otherwise 'scanning'.
 * currentLibraryPath summarises the active paths (single name or "<n> libraries").
 *
 * Returns null when no keys exist or none could be parsed.
 */
export async function getAggregateScanProgress(): Promise<FileScannerProgress | null> {
    if (!isValkeyReady()) return null;
    const keys = await getKeysByPattern(`${KEY_PREFIX}*`);
    if (keys.length === 0) return null;

    const parsed: FileScannerProgress[] = [];
    for (const k of keys) {
        const raw = await cacheGet(k);
        if (!raw) continue;
        try {
            const entry = JSON.parse(raw) as FileScannerProgress;
            // Skip keys for scans that already finished but whose key lingers
            // (600s TTL, or a delete that raced/failed on a Valkey blip).
            // Summing a completed run's processed==total into a freshly-started
            // scan would otherwise inflate the aggregate to a false ~100%.
            if (entry.totalFiles > 0 && entry.processedFiles >= entry.totalFiles) continue;
            parsed.push(entry);
        } catch {
            /* skip malformed entry */
        }
    }
    if (parsed.length === 0) return null;

    const aggregate: FileScannerProgress = {
        totalFiles: 0,
        processedFiles: 0,
        currentFile: '',
        currentLibraryPath: '',
        added: 0,
        updated: 0,
        skipped: 0,
        unmatched: 0,
        errors: 0,
        phase: 'scanning',
    };

    const activePaths: string[] = [];
    for (const p of parsed) {
        aggregate.totalFiles += p.totalFiles;
        aggregate.processedFiles += p.processedFiles;
        aggregate.added += p.added;
        aggregate.updated += p.updated;
        aggregate.skipped += p.skipped;
        aggregate.unmatched += p.unmatched;
        aggregate.errors += p.errors;
        if (p.phase === 'discovering') aggregate.phase = 'discovering';
        if (p.currentLibraryPath) activePaths.push(p.currentLibraryPath);
        if (p.currentFile) aggregate.currentFile = p.currentFile;
    }

    if (activePaths.length === 1) {
        aggregate.currentLibraryPath = activePaths[0];
    } else if (activePaths.length > 1) {
        aggregate.currentLibraryPath = `${activePaths.length} libraries`;
    }

    return aggregate;
}
