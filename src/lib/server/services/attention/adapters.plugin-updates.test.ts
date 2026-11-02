// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Plugin updates (design §9 Slice 4, "updates — poll, always info").
 *
 * The update CHECK task has recorded `available_version` since it shipped and
 * nothing read the column: the check ran on schedule, wrote its answer, and no
 * surface ever mentioned it.
 *
 * The rule worth protecting is the severity. An available update is NOT a
 * fault — nothing is broken, nothing is degraded, and an operator may have
 * good reasons to stay put. A board that turns amber because someone else
 * released software is a board people stop reading, which is the same decay
 * the red budget guards against arriving by a different door.
 */

import { describe, it, expect } from 'vitest';
import { adaptPluginUpdates } from './adapters.js';
import type { PluginUpdateRow } from '$lib/server/database/queries/plugin-repositories.queries.js';

function row(over: Partial<PluginUpdateRow> = {}): PluginUpdateRow {
    return {
        name: 'acme-scrobbler',
        installedVersion: '1.0.0',
        availableVersion: '2.1.0',
        ...over,
    };
}

describe('adaptPluginUpdates', () => {
    it('says nothing when everything is current', () => {
        expect(adaptPluginUpdates([])).toEqual([]);
    });

    it('is ALWAYS info, never a warning', () => {
        // The load-bearing assertion. Raising this to warning would make the
        // dashboard nonzero for something that is not wrong.
        const many = [row(), row({ name: 'b' }), row({ name: 'c' })];
        for (const alerts of [adaptPluginUpdates([row()]), adaptPluginUpdates(many)]) {
            expect(alerts[0].severity).toBe('info');
        }
    });

    it('names the plugin and version when there is exactly one', () => {
        const [a] = adaptPluginUpdates([row()]);
        expect(a.title).toContain('acme-scrobbler');
        expect(a.title).toContain('2.1.0');
    });

    it('aggregates rather than emitting one row per plugin', () => {
        // Updates arrive in batches; N identical rows would crowd out problems
        // that actually are wrong.
        const alerts = adaptPluginUpdates([row(), row({ name: 'b' }), row({ name: 'c' })]);
        expect(alerts).toHaveLength(1);
        expect(alerts[0].count).toBe(3);
        expect(alerts[0].title).toContain('3');
    });

    it('re-surfaces for a NEW version but not for the same one again', () => {
        // Fingerprint is the exact set of target versions, so an ack survives a
        // re-detection and breaks when something genuinely new appears.
        const a = adaptPluginUpdates([row()])[0].fingerprint;
        const same = adaptPluginUpdates([row()])[0].fingerprint;
        const newer = adaptPluginUpdates([row({ availableVersion: '2.2.0' })])[0].fingerprint;
        expect(same).toBe(a);
        expect(newer).not.toBe(a);
    });

    it('states the plugins domain and points at the plugins page', () => {
        const [a] = adaptPluginUpdates([row()]);
        expect(a.domain).toBe('plugins');
        expect(a.sourceRef).toContain('/admin/settings/plugins');
    });

    it('never implies something is broken', () => {
        const [a] = adaptPluginUpdates([row()]);
        // Reworded in b4dbb65ae ("plain wording"); the reassurance is now that
        // the installed version keeps working.
        expect(a.detail).toMatch(/keeps working/i);
        expect(a.detail).not.toMatch(/broken|fail|error/i);
    });
});
