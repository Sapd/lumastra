// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { BASE_SCHEMA_VERSION } from './base-schema.js';
import { MIGRATIONS } from './migrate-schema.js';

function compareVersions(a: string, b: string): number {
    const left = a.split('.').map(Number);
    const right = b.split('.').map(Number);
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
        const diff = (left[i] ?? 0) - (right[i] ?? 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

// Versions, names and checksums of a migration that has been deployed stay immutable, so
// every migration registered here is one that no deployed database has applied yet.
describe('production migration registry', () => {
    it('registers every version and migration name exactly once', () => {
        expect(new Set(MIGRATIONS.map((migration) => migration.version)).size).toBe(
            MIGRATIONS.length,
        );
        expect(new Set(MIGRATIONS.map((migration) => migration.name)).size).toBe(MIGRATIONS.length);
    });

    it('registers only migrations newer than the squashed base schema', () => {
        for (const migration of MIGRATIONS) {
            expect(
                compareVersions(migration.version, BASE_SCHEMA_VERSION),
                `${migration.version} is at or below BASE_SCHEMA_VERSION ${BASE_SCHEMA_VERSION}: its file was squashed away or it will never run`,
            ).toBeGreaterThan(0);
        }
    });

    it('lists the migrations newer than the squashed base, in order', () => {
        expect(MIGRATIONS.map((m) => ({ version: m.version, name: m.name }))).toEqual([
            { version: '16.468.0', name: 'play_sessions_download_purpose' },
            { version: '16.469.0', name: 'trickplay_measured_height' },
        ]);
    });
});
