// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Form-choice → `POST /api/me/pats` body mapping for the self-service
 * Personal Access Token modal.
 *
 * This lives outside the component because both fields MUST be transmitted:
 * the endpoint falls back to `['read']` and no expiry when they are absent, so
 * a name-only payload silently minted read-only tokens whose every write was
 * rejected with `insufficient_scope`. Keeping the mapping here makes that
 * contract directly testable — a `<select>` cannot be driven under happy-dom
 * (see the note in ApiTokensPanel.svelte.test.ts).
 */

/**
 * Access level offered to non-admin users.
 *
 * `admin` is deliberately absent: the endpoint rejects it for non-admin users,
 * and administrators issue admin-scoped tokens from Admin → API tokens.
 */
export type PatScopeChoice = 'read' | 'write';

/** Expiry options. `never` is a form sentinel mapping to `expiresInDays: null`. */
export type PatExpiryChoice = '30' | '90' | '365' | 'never';

export interface PatCreatePayload {
    name: string;
    scopes: ('read' | 'write')[];
    expiresInDays: number | null;
}

/** Defaults the modal opens with, and returns to after every close. */
export const PAT_FORM_DEFAULTS: { scope: PatScopeChoice; expiry: PatExpiryChoice } = {
    scope: 'write',
    expiry: '365',
};

/**
 * Days per expiry choice. A lookup rather than `Number(choice)` so an
 * unrecognised choice cannot coerce to `NaN` — that serialises to `null` in
 * JSON, which the endpoint reads as "never expires". Silently upgrading a
 * token to unlimited lifetime is exactly the class of bug this module exists
 * to prevent, so an unknown choice throws instead.
 */
const EXPIRY_DAYS: Record<PatExpiryChoice, number | null> = {
    '30': 30,
    '90': 90,
    '365': 365,
    never: null,
};

/** Builds the create-token request body from the modal's current selections. */
export function patCreatePayload(
    name: string,
    scope: PatScopeChoice,
    expiry: PatExpiryChoice,
): PatCreatePayload {
    if (!(expiry in EXPIRY_DAYS)) {
        throw new Error(`Unsupported PAT expiry choice: ${String(expiry)}`);
    }
    return {
        name: name.trim(),
        // 'write' alone would be accepted, but every write-capable token also
        // reads — sending both keeps the stored scopes self-describing.
        scopes: scope === 'write' ? ['read', 'write'] : ['read'],
        expiresInDays: EXPIRY_DAYS[expiry],
    };
}
