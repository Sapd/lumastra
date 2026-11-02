// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Admin Nav Pins Query Module
 *
 * CRUD for instance-wide pinned admin nav quick-links.
 */

import { defineQuery, defineWriteQuery } from '../typed-query.js';

export interface AdminNavPinRow {
    href: string;
    label: string;
    sort_order: number;
    created_at: Date;
}

/**
 * Get all pinned nav items, ordered by sort_order.
 */
export const getNavPins = defineQuery<Record<string, never>, AdminNavPinRow>(
    'getNavPins',
    (sql) => sql`
        SELECT href, label, sort_order, created_at
        FROM admin_nav_pins
        ORDER BY sort_order ASC, created_at ASC
    `,
);

/**
 * Pin a nav item. sort_order defaults to max+1 (append to end).
 */
export const addNavPin = defineWriteQuery<{ href: string; label: string }, AdminNavPinRow>(
    'addNavPin',
    (sql, { href, label }) => sql`
        INSERT INTO admin_nav_pins (href, label, sort_order)
        VALUES (
            ${href},
            ${label},
            COALESCE(
                (SELECT MAX(sort_order) + 1 FROM admin_nav_pins),
                0
            )
        )
        ON CONFLICT (href) DO UPDATE SET
            label = EXCLUDED.label
        RETURNING href, label, sort_order, created_at
    `,
);

/**
 * Remove a pinned nav item.
 */
export const removeNavPin = defineWriteQuery<{ href: string }, { href: string }>(
    'removeNavPin',
    (sql, { href }) => sql`
        DELETE FROM admin_nav_pins
        WHERE href = ${href}
        RETURNING href
    `,
);

/**
 * Self-heal a pin whose `href` points at a legacy admin path (admin IA
 * redesign left `admin_nav_pins.href` — a raw string, not FK'd to anything —
 * pointing at routes that were later deleted).
 *
 * Single statement, no app-level try/catch needed for the unique-violation
 * case: `INSERT ... ON CONFLICT (href) DO NOTHING` copies the pin's label/
 * sort_order onto `newHref` UNLESS a pin already lives there (in which case
 * the insert is silently skipped, keeping whatever's already pinned at
 * `newHref`); the old row is then unconditionally deleted either way, so a
 * pin never ends up duplicated across its old and new href.
 */
export const updateNavPinHref = defineWriteQuery<
    { oldHref: string; newHref: string },
    { href: string }
>(
    'updateNavPinHref',
    (sql, { oldHref, newHref }) => sql`
        WITH ins AS (
            INSERT INTO admin_nav_pins (href, label, sort_order)
            SELECT ${newHref}, label, sort_order
            FROM admin_nav_pins
            WHERE href = ${oldHref}
            ON CONFLICT (href) DO NOTHING
            RETURNING href
        )
        DELETE FROM admin_nav_pins
        WHERE href = ${oldHref}
        RETURNING href
    `,
);
