// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The DIRECT / REMUX / TRANS badge on a row of the ambient streaming strip.
 *
 * A module rather than two `const`s in StreamingSummary.svelte because nothing
 * in this repo type-checks a lookup map written inside a component: `npm run
 * typecheck` runs tsgo, which does not read `.svelte` at all, and `npm run
 * check` (svelte-check-native) was MEASURED on 2026-08-27 not to flag a renamed
 * key in a component-local `Record<Union, …>` either.
 *
 * `StreamMethodSchema` is a coarse enum on the server side —
 * `audio_transcode` and `full_transcode` already collapse into `transcode` —
 * so widening it is a live possibility, and the badge is the ONLY thing on the
 * row that says how a stream is being served. A missing entry rendered the
 * badge with no text at all: a visible, empty, bordered chip, which reads as a
 * rendering fault rather than as "we don't know".
 */

import type { StreamMethod } from '$lib/schemas/api-streaming-responses.js';

/** Border + text colour for the badge. */
export function streamMethodStyle(method: StreamMethod): string {
    switch (method) {
        case 'direct':
            return 'text-emerald-300 border-emerald-500/40';
        case 'remux':
            return 'text-blue-300 border-blue-500/40';
        case 'transcode':
            return 'text-amber-300 border-amber-500/40';
    }
}

/** Badge text, abbreviated to fit the strip's one-line row. */
export function streamMethodLabel(method: StreamMethod): string {
    switch (method) {
        case 'direct':
            return 'DIRECT';
        case 'remux':
            return 'REMUX';
        case 'transcode':
            return 'TRANS';
    }
}
