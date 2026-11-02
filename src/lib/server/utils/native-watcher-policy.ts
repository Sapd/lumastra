// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Builds the native watcher's init policy from the scanner's own constants
 * plus the containment roots and sensitive prefixes this install uses.
 */

import { resolve } from 'node:path';
import { getContainmentRoots, getSensitivePrefixes } from './contained-fs.js';
import { nativeWatcherPolicy, type NativeWatcherPolicyV2 } from './media-file-kinds.js';
import { safeRealpath } from './safe-fs.js';

/**
 * @param roots - the watched library roots (logical, as configured). They are added
 *   to the containment roots in lexical and realpath form.
 */
export async function buildNativeWatcherPolicy(roots: string[]): Promise<NativeWatcherPolicyV2> {
    const containment = new Set<string>();
    const add = async (p: string): Promise<void> => {
        if (!p) return;
        containment.add(resolve(p));
        try {
            containment.add(await safeRealpath(p));
        } catch {
            // not mounted right now: the lexical form still applies
        }
    };
    for (const r of [...roots, ...(await getContainmentRoots())]) await add(r);
    return nativeWatcherPolicy({
        containmentRoots: [...containment],
        sensitivePrefixes: await getSensitivePrefixes(),
    });
}
