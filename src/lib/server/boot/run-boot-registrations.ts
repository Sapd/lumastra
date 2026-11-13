// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The web server's boot sequence for the registries (hooks.server.ts):
 * wait for the database migration, then load `boot/compat-init.ts`.
 *
 * The two steps are independent on purpose. A migration that rejects must not
 * leave the /j session revocation, the AI assistant provider and the other
 * registries empty, so the loader runs either way. Never throws.
 */

export interface BootRegistrationDeps {
    /** Resolves when the database is migrated; may reject. */
    migrate: () => Promise<unknown>;
    /** Loads the registrations (and starts the enrolment loop). */
    loadCompat: () => Promise<unknown>;
    warn: (message: string, meta: Record<string, unknown>) => void;
}

export async function runBootRegistrations(deps: BootRegistrationDeps): Promise<void> {
    try {
        await deps.migrate();
    } catch (err) {
        deps.warn('Database migration did not finish before the boot registrations', {
            error: String(err),
        });
    }
    try {
        await deps.loadCompat();
    } catch (err) {
        deps.warn('Failed to run the boot registrations', { error: String(err) });
    }
}
