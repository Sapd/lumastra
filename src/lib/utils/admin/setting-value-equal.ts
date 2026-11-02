// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { toList } from '$lib/config/schema';

/**
 * Whether an edited settings value is the one already stored.
 *
 * By content, not reference: object and list inputs emit a fresh value on every
 * change, so `===` never matched and an edit typed back to the original stayed
 * "unsaved". The list input also emits its comma-separated TEXT while the
 * stored value is an array, so `"a, b"` and `["a", "b"]` are the same value.
 */
export function settingValueEqual(edited: unknown, stored: unknown): boolean {
    if (edited === stored) return true;
    if (Array.isArray(stored) && typeof edited === 'string') {
        return JSON.stringify(toList(edited)) === JSON.stringify(toList(stored));
    }
    return JSON.stringify(edited) === JSON.stringify(stored);
}
