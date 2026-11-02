// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Items a task reported it could not process (design §9 Slice 4, "plugins from
 * plugin_failure_events").
 *
 * This is a DIFFERENT population from the dead-letter adapter, which counts
 * `media_item_stage_state.status = 'failed_permanent'`. A task reports through
 * `ctx.reportFailure` when one item defeats it, and that need not fail the
 * stage. Measured on preprod before building this: 11 unresolved plugin
 * failures against 0 failed_permanent stage rows, overlapping in nothing — so
 * they were reachable only by opening each task's Failures tab in turn, and
 * absent from the board that exists to say what needs attention.
 *
 * That measurement is why this producer exists at all. The codebase has fought
 * dual-signals before ("adaptOutboxDeadLetter is the single owner..."), so a
 * second source for the same rows would have been the wrong thing to add.
 */

import { describe, it, expect } from 'vitest';
import { adaptPluginFailures } from './adapters.js';
import * as m from '$lib/paraglide/messages.js';
import type { PluginFailureCountRow } from '$lib/server/database/queries/plugin-failure-events.queries.js';

const NAMES: Record<string, string> = { 'media-probe': 'Media File Probe' };
const nameFor = (id: string) => NAMES[id] ?? id;

function rows(...r: PluginFailureCountRow[]): PluginFailureCountRow[] {
    return r;
}

describe('adaptPluginFailures', () => {
    it('says nothing when no task is failing items', () => {
        expect(adaptPluginFailures([], nameFor)).toEqual([]);
        expect(adaptPluginFailures(rows({ pluginId: 'media-probe', count: 0 }), nameFor)).toEqual(
            [],
        );
    });

    it('uses the task’s CATALOG name, never the raw id', () => {
        // The board is operator-facing; "media-probe" is a developer slug.
        const [a] = adaptPluginFailures(rows({ pluginId: 'media-probe', count: 4 }), nameFor);
        expect(a.title).toContain('Media File Probe');
        expect(a.title).not.toContain('media-probe');
    });

    it('is a warning, not a critical', () => {
        // The items are recorded, named and retryable, and the rest of the
        // library is unaffected. Red is for things that stop the server working.
        const [a] = adaptPluginFailures(rows({ pluginId: 'media-probe', count: 400 }), nameFor);
        expect(a.severity).toBe('warning');
    });

    it('emits one item per TASK, not one per failure', () => {
        const alerts = adaptPluginFailures(
            rows({ pluginId: 'media-probe', count: 7 }, { pluginId: 'image-sync', count: 2 }),
            nameFor,
        );
        expect(alerts).toHaveLength(2);
        expect(alerts.map((a) => a.count)).toEqual([7, 2]);
    });

    it('links straight to the failing task’s Failures tab', () => {
        const [a] = adaptPluginFailures(rows({ pluginId: 'media-probe', count: 4 }), nameFor);
        expect(a.sourceRef).toBe('/admin/tasks/media-probe?tab=failures');
    });

    it('keeps an ack across small drift but not a real jump', () => {
        // A count that wanders by one must not re-surface an acked alert every
        // cycle; an order-of-magnitude change should.
        const f = (n: number) =>
            adaptPluginFailures(rows({ pluginId: 'media-probe', count: n }), nameFor)[0]
                .fingerprint;
        expect(f(4)).toBe(f(5));
        expect(f(4)).not.toBe(f(400));
    });

    it('only promises a retry when the task offers one', () => {
        const [yes] = adaptPluginFailures(rows({ pluginId: 'media-probe', count: 4 }), nameFor);
        const [no] = adaptPluginFailures(
            rows({ pluginId: 'media-probe', count: 4 }),
            nameFor,
            () => false,
        );
        expect(yes.detail).toBe(m.admin_attention_plugin_failures_detail());
        expect(no.detail).toBe(m.admin_attention_plugin_failures_detail_no_retry());
        expect(no.detail).not.toBe(yes.detail);
    });

    it('falls back to the id when a task has no catalog entry', () => {
        // An uninstalled or renamed plugin still has failures worth showing.
        const [a] = adaptPluginFailures(rows({ pluginId: 'ghost-task', count: 1 }), nameFor);
        expect(a.title).toContain('ghost-task');
    });
});
