// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import type { JSONValue } from 'postgres';

// Migration 15.0.0 dropped the old single-row `task_settings(task_id, settings)`
// table and replaced it with `plugin_settings(plugin_id, key, value)` — key/value
// rows per plugin. These helpers reconstruct the legacy object-shaped API on top
// of the new schema so existing callers (music-popularity, album-enrichment,
// artist-enrichment, lumastra-intro-analyzer settings load) keep working without
// each having to know the row-per-key layout.

// Reserved property names that, when assigned to a fresh object literal, mutate
// the prototype chain instead of writing an own property. Plugin authors are
// not expected to write these keys, but plugin_settings is an EAV table whose
// rows are operator-writable from the admin UI; filter them out as a defence.
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export async function getTaskSettings(
    sql: postgres.Sql,
    taskId: string,
): Promise<Record<string, unknown>> {
    const rows = await sql<{ key: string; value: unknown }[]>`
        SELECT key, value FROM plugin_settings WHERE plugin_id = ${taskId}
    `;
    // Null-prototype is deliberate — prevents UNSAFE_KEYS like `__proto__`
    // from being usable as inherited properties. Cast through unknown so
    // typed-lint accepts the assignment (Object.create returns `any`).
    const out = Object.create(null) as unknown as Record<string, unknown>;
    for (const r of rows) {
        if (UNSAFE_KEYS.has(r.key)) continue;
        out[r.key] = r.value;
    }
    return out;
}

export async function upsertTaskSettings(
    sql: postgres.Sql,
    taskId: string,
    settings: Record<string, unknown>,
): Promise<void> {
    // The legacy "whole object" upsert maps to a key-by-key upsert against the
    // new schema. Keys not in `settings` are NOT deleted — caller has to clear
    // those explicitly if it wants destructive overwrite semantics.
    const entries = Object.entries(settings).filter(([key, value]) => {
        if (UNSAFE_KEYS.has(key)) return false;
        // tx.json(undefined) has undefined driver behaviour; skip rather than
        // risk writing SQL NULL when the caller almost certainly meant "don't
        // touch this key".
        if (value === undefined) return false;
        return true;
    });
    if (entries.length === 0) return;
    // Each upsert is independently idempotent via `ON CONFLICT (plugin_id,
    // key) DO UPDATE`, so wrapping the loop in `sql.begin` buys atomicity we
    // don't need and breaks if the caller is already inside a transaction
    // (postgres-js translates it into a SAVEPOINT whose rollback only undoes
    // OUR loop, while the outer transaction keeps any state from earlier
    // upsertTaskSettings keys). Plain sequential upserts give the same
    // observable result without that footgun.
    for (const [key, value] of entries) {
        await sql`
            INSERT INTO plugin_settings (plugin_id, key, value, updated_at)
            VALUES (${taskId}, ${key}, ${sql.json(value as JSONValue)}, NOW())
            ON CONFLICT (plugin_id, key) DO UPDATE SET
                value = EXCLUDED.value,
                updated_at = NOW()
        `;
    }
}

/**
 * Add `value` to the JSON string array stored under (taskId, key), in ONE
 * statement — no read-modify-write, so two concurrent callers cannot drop each
 * other's entry. A missing row or a non-array value starts a fresh array; an
 * entry already present is left alone.
 */
export async function addToTaskSettingList(
    sql: postgres.Sql,
    taskId: string,
    key: string,
    value: string,
): Promise<void> {
    if (UNSAFE_KEYS.has(key)) return;
    await sql`
        INSERT INTO plugin_settings (plugin_id, key, value, updated_at)
        VALUES (${taskId}, ${key}, jsonb_build_array(${value}::text), NOW())
        ON CONFLICT (plugin_id, key) DO UPDATE SET
            value = CASE
                WHEN jsonb_typeof(plugin_settings.value) <> 'array'
                    THEN jsonb_build_array(${value}::text)
                WHEN plugin_settings.value @> jsonb_build_array(${value}::text)
                    THEN plugin_settings.value
                ELSE plugin_settings.value || jsonb_build_array(${value}::text)
            END,
            updated_at = NOW()
    `;
}

/** Remove every occurrence of `value` from that array, in one statement. */
export async function removeFromTaskSettingList(
    sql: postgres.Sql,
    taskId: string,
    key: string,
    value: string,
): Promise<void> {
    await sql`
        UPDATE plugin_settings
           SET value = value - ${value}::text, updated_at = NOW()
         WHERE plugin_id = ${taskId} AND key = ${key} AND jsonb_typeof(value) = 'array'
    `;
}
