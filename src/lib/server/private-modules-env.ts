// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Whether a private module was switched on for this process, for the public
 * code that must not show a link to it (the admin navigation).
 *
 * The private route trees answer 404 unless `LUMASTRA_PRIVATE_MODULES` names
 * their module (`all`, or a comma list). This reads the same variable with the
 * same rules, so the admin nav never offers an entry whose page or API is off
 * or not even present in this build. The route trees keep their own gate; this
 * one only decides visibility.
 */

export type PrivateModuleName = 'assessment' | 'showcase';

/** Read live, never cached. */
export function privateModuleSwitchedOn(name: PrivateModuleName): boolean {
    const raw = (process.env.LUMASTRA_PRIVATE_MODULES ?? '').trim().toLowerCase();
    if (raw === '') return false;
    if (raw === 'all') return true;
    return raw
        .split(',')
        .map((part) => part.trim())
        .includes(name);
}
