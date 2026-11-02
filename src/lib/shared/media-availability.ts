// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read authoritative availability evidence from one media-shaped value.
 * The canonical nested contract wins, followed by flat API aliases and then
 * explicit file-presence signals. IDs and provider metadata are never evidence.
 */
export function readMediaAvailability(value: unknown): boolean | undefined {
    if (!isRecord(value)) return undefined;

    const nested = isRecord(value.availability) ? value.availability : undefined;
    const candidates = [
        nested?.isAvailable,
        value.isAvailable,
        value.is_available,
        nested?.hasFile,
        nested?.hasFiles,
        nested?.has_files,
        value.hasFile,
        value.hasFiles,
        value.has_files,
    ];

    return candidates.find((candidate): candidate is boolean => typeof candidate === 'boolean');
}

/**
 * Resolve availability across values ordered from freshest/most authoritative
 * to oldest. Missing or malformed signals are conservatively unavailable.
 */
export function resolveMediaAvailability(...sources: unknown[]): boolean {
    for (const source of sources) {
        const available = readMediaAvailability(source);
        if (available !== undefined) return available;
    }
    return false;
}

/** Read requestability without losing an explicit false value. */
export function readMediaRequestability(value: unknown): boolean | undefined {
    if (!isRecord(value)) return undefined;
    const nested = isRecord(value.availability) ? value.availability : undefined;
    const candidates = [nested?.canRequest, value.canRequest, value.can_request];
    return candidates.find((candidate): candidate is boolean => typeof candidate === 'boolean');
}

/** Resolve requestability across values ordered from freshest to oldest. */
export function resolveMediaRequestability(...sources: unknown[]): boolean {
    for (const source of sources) {
        const canRequest = readMediaRequestability(source);
        if (canRequest !== undefined) return canRequest;
    }
    return false;
}
