// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { deriveSectionStatus, sectionForItem } from './admin-status-payload.service.js';
import { IDS_BY_SECTION, attentionItem } from '$lib/shared/__fixtures__/attention-section-ids.js';
import { ATTENTION_SOURCE_PREFIXES } from './attention/attention-service.js';
import { readFileSync } from 'node:fs';

/**
 * The representative-id table and the item builder both live in
 * `$lib/shared/__fixtures__/attention-section-ids.js` so the guards over
 * `sectionForItem`'s two CONSUMERS — `SectionAttentionStrip.svelte` and
 * `nav-status.ts` — read the same list. The completeness check below is what
 * makes that list authoritative; sharing it is what carries the guarantee
 * across to them.
 */
const item = attentionItem;

describe('sectionForItem', () => {
    it.each(Object.entries(IDS_BY_SECTION))(
        'maps every %s prefix to that section',
        (section, ids) => {
            for (const id of ids) {
                expect(sectionForItem({ id }), id).toBe(section);
            }
        },
    );

    it('maps component health and unknown prefixes to system (Health is the catch-all)', () => {
        expect(sectionForItem({ id: 'degraded-component:valkey' })).toBe('system');
        expect(sectionForItem({ id: 'optional-dependency:sonarr' })).toBe('system');
        expect(sectionForItem({ id: 'lumastra-playback:ffmpeg' })).toBe('system');
        expect(sectionForItem({ id: 'some-future-source:x' })).toBe('system');
    });

    /**
     * The structural guard. Reads the `startsWith('…')` literals out of the map
     * SOURCE and requires each one to be exercised above.
     *
     * Reading the source rather than calling the function is the point: a
     * missing branch is invisible to a test that only asserts about ids it
     * already knows, which is precisely how `scan-run:` and `music-hygiene:`
     * both reached `system` while every existing assertion here stayed green.
     */
    it('covers every id prefix the map branches on', () => {
        const source = readFileSync(
            new URL('../../shared/attention-section-map.ts', import.meta.url),
            'utf8',
        );
        const branched = [...source.matchAll(/id\.startsWith\('([^']+)'\)/g)].map((m) => m[1]);
        expect(branched.length).toBeGreaterThan(10);

        const covered = Object.values(IDS_BY_SECTION).flat();
        for (const prefix of branched) {
            expect(
                covered.some((id) => id.startsWith(prefix)),
                `attention-section-map branches on "${prefix}" but no id in IDS_BY_SECTION covers it`,
            ).toBe(true);
        }
    });

    /**
     * The guard above reads BRANCHES and requires each to be exercised. That is
     * one direction only: it catches "someone added a branch and no test id",
     * and is structurally blind to the failure that actually shipped — a new
     * PRODUCER whose prefix has no branch at all, which falls through to
     * `system`, lights the wrong nav dot, and renders on the Health page with
     * every adapter, reconcile, link and page test still green. `scan-run:` and
     * `music-hygiene:` both shipped that way in one plan, under a guard whose
     * comment claimed the class was closed.
     *
     * So enumerate the producer side too, from `ATTENTION_SOURCE_PREFIXES` —
     * derived from the real `SOURCES` array plus the separately-handled backlog
     * and liveness prefixes, so a source added tomorrow is in this list the same
     * moment. A new source must classify itself or be named below, deliberately.
     *
     * Revert-check: add a throwaway `{ prefix: 'throwaway-source:', run: … }` to
     * `SOURCES` with no branch in `attention-section-map.ts` and this fails with
     * `throwaway-source: falls through to "system"`. (Run and restore
     * byte-identically — it is a real entry in a real fan-out.)
     */
    const INTENTIONALLY_SYSTEM = new Set([
        // Component/dependency/playback health and cluster identity: real
        // problems with no nav section of their own. Health IS their page.
        'degraded-component:',
        'degraded-component:disk:',
        'optional-dependency:',
        'lumastra-playback:',
        'cluster-key-mismatch',
        // Memory pressure and unclean exits link to the Cluster tab on Health.
        'resource-pressure:',
        'unclean-exits:',
        // An incompatible Live TV proxy links to the Cluster tab of the Health page.
        'livetv-proxy-compat',
        // `storage` and `transcoding` are real domains
        // (shared/attention-domain.ts) with no `AdminSectionId`. Forcing them
        // onto Library or Tasks is the exact "wrong dot" bug the invariant-bridge
        // rename fixed, so they stay here on purpose.
        'storage:capacity',
        'storage:forecast',
        'storage:',
        'transcoding:',
        // Lumastra update notices link to System → Instance, which IS in the
        // System section: `system` is the right dot, not a fall-through.
        'lumastra-update:',
    ]);

    it('classifies every producer prefix, or names it as deliberately system', () => {
        expect(ATTENTION_SOURCE_PREFIXES.length).toBeGreaterThan(15);

        for (const prefix of ATTENTION_SOURCE_PREFIXES) {
            const section = sectionForItem({ id: `${prefix}probe` });
            if (INTENTIONALLY_SYSTEM.has(prefix)) {
                expect(section, `${prefix} is allowlisted as system`).toBe('system');
            } else {
                expect(section, `${prefix} falls through to "system"`).not.toBe('system');
            }
        }
    });

    /**
     * The allowlist must not outlive its producers, or a retired source leaves a
     * blanket exemption behind that silently covers the next prefix to reuse the
     * namespace.
     */
    it('allowlists only prefixes that are still real producers', () => {
        for (const prefix of INTENTIONALLY_SYSTEM) {
            expect(
                ATTENTION_SOURCE_PREFIXES.includes(prefix),
                `"${prefix}" is allowlisted as system but no source produces it`,
            ).toBe(true);
        }
    });
});

describe('deriveSectionStatus', () => {
    it('returns healthy for every section when there are no items', () => {
        const status = deriveSectionStatus([]);
        expect(Object.keys(status).sort()).toEqual([
            'developer',
            'home',
            'library',
            'settings',
            'system',
            'tasks',
            'users',
        ]);
        expect(Object.values(status).every((v) => v === 'healthy')).toBe(true);
    });

    it('derives the worst verdict per section (critical beats warning)', () => {
        const status = deriveSectionStatus([
            item({ id: 'failed-run-spike:a', severity: 'warning' }),
            item({ id: 'circuit:b', severity: 'critical' }),
            item({ id: 'file-health:all', severity: 'warning' }),
        ]);
        expect(status.tasks).toBe('critical');
        expect(status.library).toBe('degraded');
        expect(status.system).toBe('healthy');
    });

    it('mirrors the global verdict semantics: info never degrades, acked/snoozed excluded', () => {
        const status = deriveSectionStatus([
            item({ id: 'unmatched:all', severity: 'info' }),
            item({ id: 'circuit:b', severity: 'critical', acked: true }),
            item({ id: 'gave-up:all', severity: 'warning', snoozed: true }),
        ]);
        expect(status.library).toBe('healthy');
        expect(status.tasks).toBe('healthy');
    });
});
