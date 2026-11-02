// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the delete confirmation dialog should do after a delete attempt comes
 * back as a non-409 failure, a 409 with no cascade-eligible children, or a 409
 * describing children a cascade would remove.
 *
 * Pure so the decision itself is testable independent of the fetch and the
 * dialog's own state machine, both of which stay in `+page.svelte` — this is
 * the one branch of that flow where a destructive confirmation could quietly
 * stop asking if the extraction drifted from the API's actual behaviour.
 */
export type DeleteFailureAction =
    { kind: 'confirmCascade'; childCount: number } | { kind: 'reportError' };

export function decideDeleteFailureAction(
    status: number,
    details: unknown,
    request: { cascade: boolean } = { cascade: false },
): DeleteFailureAction {
    // A 409 to a request that already cascaded is the server's cascade limit
    // (LUMASTRA_CASCADE_DELETE_MAX), not a question: asking again would loop
    // the dialog on the same refusal without ever saying why.
    if (request.cascade) return { kind: 'reportError' };
    if (status === 409 && typeof details === 'string') {
        try {
            const parsed = JSON.parse(details) as { childCount?: number };
            if (parsed.childCount && parsed.childCount > 0) {
                return { kind: 'confirmCascade', childCount: parsed.childCount };
            }
        } catch {
            /* malformed body — fall through to a generic error */
        }
    }
    return { kind: 'reportError' };
}
