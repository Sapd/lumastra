// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Utility functions for determining metric colors and styles in the admin UI
 *
 * These functions encapsulate the complex ternary logic for conditional styling
 * based on threshold values.
 */

/**
 * Get color class for percentage-based metrics (CPU, memory, etc.)
 * @param percent - The percentage value (0-100)
 * @param highThreshold - Threshold for warning color (default: 80)
 * @param mediumThreshold - Threshold for caution color (default: 60 for CPU, 75 for memory)
 */
export function getPercentageColor(
    percent: number,
    highThreshold: number = 80,
    mediumThreshold: number = 60,
): string {
    if (percent > highThreshold) return 'text-red-400';
    if (percent > mediumThreshold) return 'text-yellow-400';
    return 'text-blue-400'; // Default color for normal usage
}

/**
 * Get background color class for percentage-based progress bars
 */
export function getPercentageBarColor(
    percent: number,
    highThreshold: number = 80,
    mediumThreshold: number = 60,
): string {
    if (percent > highThreshold) return 'bg-red-500';
    if (percent > mediumThreshold) return 'bg-yellow-500';
    return 'bg-blue-500';
}

/**
 * Get color for memory usage (higher thresholds than CPU)
 */
export function getMemoryColor(percent: number): string {
    return getPercentageColor(percent, 90, 75);
}

/**
 * Get background color for memory usage progress bar
 */
export function getMemoryBarColor(percent: number): string {
    return getPercentageBarColor(percent, 90, 75);
}

/**
 * Get color for GPU usage
 */
export function getGpuColor(percent: number): string {
    return getPercentageColor(percent, 80, 50);
}

/**
 * Get background color for GPU usage progress bar
 */
export function getGpuBarColor(percent: number): string {
    return getPercentageBarColor(percent, 80, 50);
}

/**
 * Get status-based text color
 */
export function getStatusColor(status: string): string {
    switch (status) {
        case 'ready':
        case 'running':
        case 'completed':
            return 'text-green-400';
        case 'starting':
            return 'text-yellow-400';
        case 'stopping':
        case 'stopped':
            return 'text-gray-400';
        case 'error':
            return 'text-red-400';
        default:
            return 'text-gray-400';
    }
}

/**
 * Get status-based background color
 */
export function getStatusBg(status: string): string {
    switch (status) {
        case 'ready':
        case 'running':
        case 'completed':
            return 'bg-green-900/30';
        case 'starting':
            return 'bg-yellow-900/30';
        case 'stopping':
        case 'stopped':
            return 'bg-gray-700/30';
        case 'error':
            return 'bg-red-900/30';
        default:
            return 'bg-gray-700/30';
    }
}

/**
 * Color configuration for metric cards
 */
export type MetricColor = 'blue' | 'purple' | 'green' | 'cyan' | 'orange' | 'red' | 'yellow';

/**
 * Get icon background color class for metric cards
 */
export function getIconBgColor(color: MetricColor): string {
    switch (color) {
        case 'blue':
            return 'bg-blue-500/20';
        case 'purple':
            return 'bg-purple-500/20';
        case 'green':
            return 'bg-green-500/20';
        case 'cyan':
            return 'bg-cyan-500/20';
        case 'orange':
            return 'bg-orange-500/20';
        case 'red':
            return 'bg-red-500/20';
        case 'yellow':
            return 'bg-yellow-500/20';
    }
}

/**
 * Get icon text color class for metric cards
 */
export function getIconTextColor(color: MetricColor): string {
    switch (color) {
        case 'blue':
            return 'text-blue-400';
        case 'purple':
            return 'text-purple-400';
        case 'green':
            return 'text-green-400';
        case 'cyan':
            return 'text-cyan-400';
        case 'orange':
            return 'text-orange-400';
        case 'red':
            return 'text-red-400';
        case 'yellow':
            return 'text-yellow-400';
    }
}

/**
 * Get primary text color for metric values
 */
export function getValueColor(color: MetricColor): string {
    return getIconTextColor(color); // Same as icon color
}
