// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** A serialized HTTP(S) origin, or the administrator's explicit wildcard. */
export function isCorsOrigin(value: string): boolean {
    if (value === '*') return true;
    try {
        const url = new URL(value);
        return (
            (url.protocol === 'http:' || url.protocol === 'https:') &&
            !url.hostname.includes('*') &&
            url.origin === value
        );
    } catch {
        return false;
    }
}
