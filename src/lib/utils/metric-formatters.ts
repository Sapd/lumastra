// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Utility functions for formatting metric values in the admin UI
 */

/**
 * Format elapsed time in human-readable format
 */
export function formatElapsed(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
}

/**
 * Format system uptime in human-readable format
 */
export function formatUptime(seconds: number): string {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
}

/**
 * Format bytes per second for network/bandwidth display
 */
export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes.toFixed(0)} B/s`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB/s`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB/s`;
}

/**
 * Format a byte count as a human-readable file size (e.g., "4.2 GB", "128 MB")
 */
const FILE_SIZE_UNITS: ReadonlyArray<{ div: number; unit: string; digits: number }> = [
    { div: 1, unit: 'B', digits: 0 },
    { div: 1e3, unit: 'KB', digits: 0 },
    { div: 1e6, unit: 'MB', digits: 0 },
    { div: 1e9, unit: 'GB', digits: 1 },
    { div: 1e12, unit: 'TB', digits: 1 },
    { div: 1e15, unit: 'PB', digits: 1 },
];

export function formatFileSize(bytes: number): string {
    // A missing or corrupt size must not render as "NaN B" or "-5 B".
    if (!Number.isFinite(bytes) || bytes < 0) return '—';
    let i = FILE_SIZE_UNITS.length - 1;
    while (i > 0 && bytes < FILE_SIZE_UNITS[i].div) i -= 1;
    let { div, unit, digits } = FILE_SIZE_UNITS[i];
    let text = (bytes / div).toFixed(digits);
    // Rounding can carry into the next unit (999.6 MB -> "1000 MB"): step up.
    if (Number(text) >= 1000 && i < FILE_SIZE_UNITS.length - 1) {
        ({ div, unit, digits } = FILE_SIZE_UNITS[i + 1]);
        text = (bytes / div).toFixed(digits);
    }
    return `${text} ${unit}`;
}

/**
 * Get display status for transcode jobs.
 * Maps completed jobs (100% progress) to "completed" regardless of internal status.
 */
export function getDisplayStatus(status: string, progressPercent: number): string {
    if (progressPercent >= 100 && (status === 'ready' || status === 'stopped')) {
        return 'completed';
    }
    return status;
}

/**
 * Get GPU display name from configuration value
 */
export function getGpuDisplayName(configured: string): string {
    switch (configured) {
        case 'nvenc':
            return 'NVIDIA NVENC';
        case 'qsv':
            return 'Intel Quick Sync';
        case 'vaapi':
            return 'VA-API';
        case 'videotoolbox':
            return 'VideoToolbox';
        case 'amf':
            return 'AMD AMF';
        case 'none':
            return 'Software (CPU)';
        default:
            return configured;
    }
}
