// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Structural invariants of the `/admin/fix` surface.
 *
 * The routing here is split between a generic `[symptom]` page driven by a
 * catalogue and three bespoke pages, and nothing at runtime notices when those
 * two drift: SvelteKit prefers the static route, so a symptom with neither
 * catalogue copy NOR a route directory silently 404s only for the operator who
 * clicks it. These assertions are what makes that drift fail here instead.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SYMPTOMS, findSymptom } from '$lib/components/admin/fix/symptoms.js';
import { SIGNPOSTS } from '$lib/components/admin/fix/signposts.js';

const ROUTES_ROOT = join(process.cwd(), 'src/routes/admin/fix');

describe('symptom catalogue', () => {
    it('lists the fourteen symptoms the index promises', () => {
        expect(SYMPTOMS).toHaveLength(14);
    });

    it('gives every symptom a translated title and an href matching its id', () => {
        for (const symptom of SYMPTOMS) {
            expect(symptom.title()).not.toBe('');
            expect(symptom.href).toBe(`/admin/fix/${symptom.id}`);
        }
    });

    it('has no duplicate ids', () => {
        expect(new Set(SYMPTOMS.map((s) => s.id)).size).toBe(SYMPTOMS.length);
    });
});

describe('routing invariants', () => {
    it('backs every dedicated-route symptom with a real route directory', () => {
        for (const symptom of SYMPTOMS.filter((s) => s.dedicatedRoute === true)) {
            expect(
                existsSync(join(ROUTES_ROOT, symptom.id, '+page.svelte')),
                `no route directory backs /admin/fix/${symptom.id}`,
            ).toBe(true);
        }
    });

    it('gives every non-dedicated symptom catalogue copy for the [symptom] page', () => {
        const generic = SYMPTOMS.filter((s) => s.dedicatedRoute !== true).map((s) => s.id);
        expect(new Set(SIGNPOSTS.map((s) => s.id))).toEqual(new Set(generic));
    });

    it('does not carry catalogue copy that no symptom points at', () => {
        for (const signpost of SIGNPOSTS) {
            expect(findSymptom(signpost.id), `orphan signpost ${signpost.id}`).toBeDefined();
        }
    });

    it('has no route directory that the catalogue does not know about', () => {
        const dirs = readdirSync(ROUTES_ROOT, { withFileTypes: true })
            .filter((e) => e.isDirectory() && !e.name.startsWith('['))
            .map((e) => e.name);
        for (const dir of dirs) {
            expect(findSymptom(dir), `route /admin/fix/${dir} is in no catalogue`).toBeDefined();
        }
    });
});

/**
 * The `kind` field is a PROMISE to the operator, and until now nothing enforced it.
 *
 * `symptoms.ts` states the contract in its own header: "A signpost dressed up as a
 * diagnostic is worse than no page at all — the operator reads a checklist, believes
 * it was checked, and stops looking." Every other invariant on this surface is
 * tested (routes exist, ids are unique, no orphan directories, signposts have copy).
 * The one that gives the surface its value was enforced by nothing.
 *
 * A `diagnostic` page must actually query the running instance. These assertions are
 * deliberately structural rather than semantic — they cannot prove a page reports the
 * TRUTH, only that it asks. That is the difference between a page that could be wrong
 * and a page that never looked, and the second is the failure mode worth failing CI over.
 */
describe('the diagnostic promise', () => {
    /** Source of every page a symptom routes to — bespoke route or the generic one. */
    function pageSourceFor(id: string): string {
        const dedicated = join(ROUTES_ROOT, id, '+page.svelte');
        const path = existsSync(dedicated)
            ? dedicated
            : join(ROUTES_ROOT, '[symptom]', '+page.svelte');
        return readFileSync(path, 'utf8');
    }

    it('backs every `diagnostic` with a page that actually calls a fix endpoint', () => {
        const offenders: string[] = [];
        for (const symptom of SYMPTOMS.filter((s) => s.kind === 'diagnostic')) {
            const src = pageSourceFor(symptom.id);
            // Either the shared client (`apiGet`/`apiPost`) or one of the typed
            // `$lib/api/admin` helpers. Both end in a request to this instance;
            // neither can be satisfied by static prose.
            const queries =
                /\bapiGet\s*\(/.test(src) ||
                /\bapiPost\s*\(/.test(src) ||
                /from '\$lib\/api\/admin/.test(src);
            if (!queries) offenders.push(symptom.id);
        }
        expect(
            offenders,
            `these claim kind:'diagnostic' but their page queries nothing: ${offenders.join(', ')}`,
        ).toEqual([]);
    });

    /**
     * The inverse, and the reason the first assertion is not enough on its own: a
     * signpost that grew a live query is no longer honestly labelled either. It is
     * the cheaper mistake — an under-claim rather than an over-claim — so it fails
     * with a message that says to promote it, not to rip the query out.
     */
    it('flags a `signpost` whose page has quietly started querying', () => {
        const shouldBePromoted: string[] = [];
        for (const symptom of SYMPTOMS.filter((s) => s.kind === 'signpost')) {
            if (symptom.dedicatedRoute !== true) continue; // generic page is shared
            const src = pageSourceFor(symptom.id);
            if (/\bapiGet\s*\(/.test(src) || /\bapiPost\s*\(/.test(src)) {
                shouldBePromoted.push(symptom.id);
            }
        }
        expect(
            shouldBePromoted,
            `these query the instance but are still labelled signpost — promote them ` +
                `to kind:'diagnostic': ${shouldBePromoted.join(', ')}`,
        ).toEqual([]);
    });

    /**
     * The generic `[symptom]` page renders catalogue copy and checks nothing, so any
     * symptom it serves is a signpost by construction. A `diagnostic` routed through
     * it would be the exact lie this file exists to prevent, and would slip past the
     * assertion above whenever ANY other page in the union happened to query.
     */
    it('never routes a `diagnostic` through the generic signpost page', () => {
        const throughGeneric = SYMPTOMS.filter(
            (s) => s.kind === 'diagnostic' && s.dedicatedRoute !== true,
        ).map((s) => s.id);
        expect(throughGeneric).toEqual([]);
    });
});

describe('signpost copy', () => {
    it('gives every signpost a lede, a body and at least one real deep link', () => {
        for (const signpost of SIGNPOSTS) {
            expect(signpost.lede()).not.toBe('');
            expect(signpost.body()).not.toBe('');
            expect(signpost.links.length).toBeGreaterThan(0);
            for (const link of signpost.links) {
                expect(link.label()).not.toBe('');
                // `resolve()` takes a bare route path; a query string baked into
                // `path` would be prefixed as part of the pathname.
                expect(link.path.startsWith('/')).toBe(true);
                expect(link.path).not.toContain('?');
            }
        }
    });

    it('keeps the file-issues query string intact after splitting the shared constant', () => {
        const subtitles = SIGNPOSTS.find((s) => s.id === 'subtitles');
        const fileIssues = subtitles?.links.find((l) => l.query !== undefined);
        expect(fileIssues?.path).toBe('/admin/library/media');
        expect(fileIssues?.query).toContain('filter=file-issues');
        expect(fileIssues?.query).toContain('type=all');
    });
});

describe('endpoint defs', () => {
    it('exposes an admin-gated GET for the library scan check', async () => {
        const mod = await import('./library-scan-check.js');
        expect(mod.def.auth).toEqual({ kind: 'admin' });
        expect(mod.def.handlers.GET).toBeTypeOf('function');
    });

    it('exposes an admin-gated GET for host pressure', async () => {
        const mod = await import('./host-pressure.js');
        expect(mod.def.auth).toEqual({ kind: 'admin' });
        expect(mod.readHostPressure).toBeTypeOf('function');
    });
});

describe('parseCgroupMemoryLimit', () => {
    it('treats both uncapped spellings as "no limit" rather than a huge number', async () => {
        const { parseCgroupMemoryLimit } = await import('./host-pressure.js');
        const hostRam = 8e9;
        // cgroup v2 writes the literal word.
        expect(parseCgroupMemoryLimit('max\n', hostRam)).toBeNull();
        // cgroup v1 writes PAGE_COUNTER_MAX — reporting "9.2 EB" as the limit
        // would be worse than reporting none.
        expect(parseCgroupMemoryLimit('9223372036854771712', hostRam)).toBeNull();
    });

    it('reads a real cap', async () => {
        const { parseCgroupMemoryLimit } = await import('./host-pressure.js');
        expect(parseCgroupMemoryLimit('2147483648\n', 8e9)).toBe(2147483648);
    });
});
