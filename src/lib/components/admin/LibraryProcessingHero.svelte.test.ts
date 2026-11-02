// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen, fireEvent } from '@testing-library/svelte';

/** Let the onMount async load() resolve + the component re-render. */
function flush(): Promise<void> {
    return new Promise((r) => setTimeout(r, 80));
}
import { describe, expect, test, vi, beforeEach } from 'vitest';
import LibraryProcessingHero from './LibraryProcessingHero.svelte';

vi.mock('$lib/api/client', () => ({
    apiGet: vi.fn(),
}));

/**
 * Paraglide's compiled `messages.js` is generated output (gitignored), so a key
 * added to `messages/en.json` in this change set does not exist as a compiled
 * function until the next `paraglide:compile`. That makes the component throw
 * "<key> is not a function" at RUNTIME — invisible to typecheck, and it would
 * make this suite fail purely on build ordering rather than on behaviour.
 *
 * So: keep every already-compiled message exactly as it is, and synthesize the
 * missing ones from `messages/en.json` itself. The assertions below therefore
 * still test the REAL English copy, not invented test strings.
 */
vi.mock('$lib/paraglide/messages.js', async (importOriginal) => {
    const original = (await importOriginal()) as Record<string, unknown>;
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    // vitest runs from the project root, so this resolves without needing
    // import.meta.url (which is not a file: URL under the Svelte transform).
    const en = JSON.parse(
        readFileSync(join(process.cwd(), 'messages', 'en.json'), 'utf8'),
    ) as Record<string, string>;

    const filled: Record<string, unknown> = { ...original };
    for (const [key, template] of Object.entries(en)) {
        // Plural entries are arrays; only plain templates can be synthesized.
        if (key.startsWith('$') || typeof original[key] === 'function') continue;
        if (typeof template !== 'string') continue;
        filled[key] = (params: Record<string, unknown> = {}) =>
            template.replace(/\{(\w+)\}/g, (whole, name: string) =>
                name in params ? String(params[name]) : whole,
            );
    }
    return filled;
});

import { apiGet } from '$lib/api/client';

interface Coverage {
    total: number;
    completed: number;
    in_progress: number;
    failed: number;
    pending: number;
    skipped?: number;
    obsolete?: number;
}

function mockEndpoints(coverage: Coverage, activity: Record<string, unknown>): void {
    vi.mocked(apiGet).mockImplementation(((url: string) => {
        if (url.startsWith('/api/admin/library/coverage')) {
            return Promise.resolve({ data: { summary: coverage } });
        }
        return Promise.resolve({ data: activity });
    }) as unknown as typeof apiGet);
}

describe('LibraryProcessingHero', () => {
    beforeEach(() => {
        vi.mocked(apiGet).mockReset();
    });

    test('renders per-stage rows with eligible-denominator counts + aggregate not-applicable footer', async () => {
        // Coverage summary has work in flight (remaining = in_progress + pending > 0)
        // so the hero renders.
        mockEndpoints(
            { total: 100, completed: 40, in_progress: 5, failed: 0, pending: 10 },
            {
                stages: [
                    { completed_5m: 6, running: 4, last_completed_at: new Date().toISOString() },
                ],
                progress: [
                    {
                        // fully done: remaining 0 → ✓ done; 59,320 not applicable
                        stage_id: 'trickplay-generation',
                        completed: 48118,
                        remaining: 0,
                        notApplicable: 59320,
                        eligibleTotal: 48118,
                        completed_5m: 0,
                        running: 0,
                        failed_transient: 0,
                    },
                    {
                        // in progress: shows a percent + an ETA from completed_5m
                        stage_id: 'lumastra-intro-analyzer:visual',
                        completed: 1887,
                        remaining: 23528,
                        notApplicable: 11851,
                        eligibleTotal: 25415,
                        completed_5m: 6,
                        running: 4,
                        failed_transient: 0,
                    },
                ],
            },
        );

        render(LibraryProcessingHero);
        await flush();

        // Headline labels map from raw stage ids.
        expect(screen.getByText('Generate Trickplay Images')).toBeTruthy();
        expect(screen.getByText('Detect Intros & Credits (video)')).toBeTruthy();

        // Trickplay is fully eligible-done (remaining 0) — the ✓ done state, NOT a
        // scary "44%" that a raw total denominator would have produced.
        expect(screen.getByText('✓ done')).toBeTruthy();

        // The aggregate footer line discloses total not-applicable items.
        expect(screen.getByText(/skip some steps/)).toBeTruthy();

        // The in-progress stage shows a denomination unit ("episodes") in its N-of-M label.
        expect(screen.getAllByText(/episodes/).length).toBeGreaterThan(0);
    });

    test('renders the always-on "fully processed" done state when no work is in flight', async () => {
        mockEndpoints(
            // total > 0 and no remaining headline work → heroState 'done'. The hero
            // is always-on: it shows a "fully processed" reassurance, not a blank gap.
            { total: 100, completed: 100, in_progress: 0, failed: 0, pending: 0 },
            { stages: [], progress: [] },
        );
        const { container } = render(LibraryProcessingHero);
        await flush();
        expect(vi.mocked(apiGet)).toHaveBeenCalled();
        expect(container.querySelector('section')).not.toBeNull();
        expect(screen.getByText(/Library fully processed/)).toBeTruthy();
    });

    test('expanded panel shows currently-analyzing count and failed row', async () => {
        mockEndpoints(
            { total: 200, completed: 50, in_progress: 10, failed: 0, pending: 140 },
            {
                stages: [
                    { completed_5m: 3, running: 4, last_completed_at: new Date().toISOString() },
                ],
                progress: [
                    {
                        stage_id: 'lumastra-intro-analyzer:visual',
                        completed: 1887,
                        remaining: 23528,
                        notApplicable: 11851,
                        eligibleTotal: 25415,
                        completed_5m: 3,
                        running: 4,
                        failed_transient: 2,
                    },
                ],
            },
        );

        render(LibraryProcessingHero);
        await flush();

        // Click the row button to expand.
        const btn = screen.getByRole('button', { name: /Detect Intros & Credits \(video\)/i });
        await fireEvent.click(btn);
        await flush();

        // Expanded panel: currently analyzing.
        expect(screen.getByText(/Currently analyzing: 4 episodes/)).toBeTruthy();

        // Expanded panel: failed count in Advanced row.
        expect(screen.getByText(/2 failed \(will retry\)/)).toBeTruthy();
    });

    test('stageEta renders days for ETAs greater than 48h', async () => {
        // completed_5m = 1 → rate = 0.2/min; remaining = 25415 → mins ≈ 127,075 → ~88d
        mockEndpoints(
            { total: 100, completed: 10, in_progress: 5, failed: 0, pending: 50 },
            {
                stages: [
                    { completed_5m: 1, running: 1, last_completed_at: new Date().toISOString() },
                ],
                progress: [
                    {
                        stage_id: 'lumastra-intro-analyzer:visual',
                        completed: 1887,
                        remaining: 23528,
                        notApplicable: 0,
                        eligibleTotal: 25415,
                        completed_5m: 1,
                        running: 1,
                        failed_transient: 0,
                    },
                ],
            },
        );

        render(LibraryProcessingHero);
        await flush();

        // The compact row label should show "~Xd" for days-scale ETAs.
        expect(screen.getByText(/~\d+d/)).toBeTruthy();
    });
    // ------------------------------------------------------------------
    // Setup view (variant="setup") — the first-run experience.
    // ------------------------------------------------------------------

    /**
     * The scenario that motivates the whole setup view, using the DEFAULT
     * config verified 2026-08-26: `media-probe-a` and `music-analysis` are on
     * and moving; `trickplay-generation` is seeded eligible for every video but
     * TRICKPLAY_ENABLED is false, so it has never completed a single item; and
     * `library-embeddings` is scheduled but has no provider key, so it has
     * never completed one either.
     */
    function mockFreshInstall(): void {
        mockEndpoints(
            { total: 16526, completed: 6300, in_progress: 12, failed: 0, pending: 10226 },
            {
                stages: [
                    { completed_5m: 250, running: 12, last_completed_at: new Date().toISOString() },
                ],
                progress: [
                    {
                        stage_id: 'media-probe-a',
                        completed: 6300,
                        remaining: 10226,
                        notApplicable: 0,
                        eligibleTotal: 16526,
                        completed_5m: 250,
                        running: 12,
                        failed_transient: 3,
                        failed_permanent: 42,
                    },
                    {
                        // Trickplay: eligible for every video, never ran (disabled).
                        stage_id: 'trickplay-generation',
                        completed: 0,
                        remaining: 16526,
                        notApplicable: 0,
                        eligibleTotal: 16526,
                        completed_5m: 0,
                        running: 0,
                        failed_transient: 0,
                        failed_permanent: 0,
                    },
                    {
                        // Embeddings: scheduled, no API key, never completed one.
                        stage_id: 'library-embeddings',
                        completed: 0,
                        remaining: 16526,
                        notApplicable: 0,
                        eligibleTotal: 16526,
                        completed_5m: 0,
                        running: 0,
                        failed_transient: 0,
                        failed_permanent: 0,
                    },
                ],
            },
        );
    }

    test('setup view shows the three load-bearing reassurance lines', async () => {
        mockFreshInstall();
        render(LibraryProcessingHero, { props: { variant: 'setup' } });
        await flush();

        expect(screen.getByText(/Setting up your library/)).toBeTruthy();
        expect(screen.getByText(/You can start watching now/)).toBeTruthy();
        expect(screen.getByText(/High CPU usage is normal/)).toBeTruthy();
    });

    test('a stalled last item reads as not progressing, never as 100% with an ETA', async () => {
        // Prod 2026-09-26: 218,751 of 218,752 steps done; the one left was a
        // trickplay item its stage had declined for ten days, while "1 done in
        // last 5 min" came from ANOTHER stage. The headline said "100%" and
        // "~5 min left" — both false, and the ETA never arrived.
        mockEndpoints(
            { total: 100, completed: 99, in_progress: 0, failed: 0, pending: 1 },
            {
                stages: [
                    { completed_5m: 1, running: 0, last_completed_at: new Date().toISOString() },
                ],
                progress: [
                    {
                        stage_id: 'media-probe-a',
                        completed: 165_025,
                        remaining: 0,
                        notApplicable: 0,
                        eligibleTotal: 165_025,
                        completed_5m: 1,
                        running: 0,
                        failed_transient: 0,
                    },
                    {
                        stage_id: 'trickplay-generation',
                        completed: 53_726,
                        remaining: 1,
                        notApplicable: 0,
                        eligibleTotal: 53_727,
                        completed_5m: 0,
                        running: 0,
                        failed_transient: 0,
                    },
                ],
            },
        );
        const { container } = render(LibraryProcessingHero);
        await flush();

        expect(container.textContent).not.toMatch(/\b100 ?%/);
        expect(container.textContent).not.toMatch(/min left/);
        expect(screen.getByText(/1 item not progressing/)).toBeTruthy();
    });

    test('setup ETA is a RANGE, never a point estimate', async () => {
        mockFreshInstall();
        const { container } = render(LibraryProcessingHero, { props: { variant: 'setup' } });
        await flush();

        // "about 2h–6h left" — two distinct bounds separated by an en dash.
        const eta = screen.getByText(/about .+–.+ left/);
        expect(eta).toBeTruthy();
        const [low, high] = eta.textContent!.replace(/about |\s*left/g, '').split('–');
        expect(low.trim()).not.toBe(high.trim());

        // And nowhere does the setup view render a bare "~Nh left" point estimate.
        expect(container.textContent).not.toMatch(/~\d+h left/);
    });

    test('setup view excludes never-started stages from the bar and names them separately', async () => {
        mockFreshInstall();
        render(LibraryProcessingHero, { props: { variant: 'setup' } });
        await flush();

        // Only media-probe has started. 6300/16526 = 38%. Folding in the two
        // stuck stages would give 6300/49578 = 13% and a bar that can never
        // reach 100% on a stock install.
        expect(screen.getByText('38%')).toBeTruthy();

        // The stuck stages are disclosed by name, with no percentage.
        expect(screen.getByText(/Hasn't started yet/)).toBeTruthy();
        expect(screen.getByText('Scrubbing previews')).toBeTruthy();
        expect(screen.getByText('Recommendations')).toBeTruthy();
        expect(screen.getByText(/switched off or missing an API key/)).toBeTruthy();
    });

    test('setup view never labels previews "the slow one"', async () => {
        // The ideas doc mockup annotated the previews row "this is the slow
        // one". TRICKPLAY_ENABLED defaults to false, so on a default first run
        // previews are not a phase at all and that annotation would be false.
        mockFreshInstall();
        const { container } = render(LibraryProcessingHero, { props: { variant: 'setup' } });
        await flush();
        expect(container.textContent).not.toMatch(/slow one/i);
    });

    test('setup view suppresses the per-item failure count until the pass ends', async () => {
        mockFreshInstall(); // 42 permanent + 3 transient failures
        const { container } = render(LibraryProcessingHero, { props: { variant: 'setup' } });
        await flush();

        // No raw failure numbers while 16k items are in flight (§6.3) — only
        // the fact that problems are being collected.
        expect(container.textContent).not.toMatch(/42/);
        expect(screen.getByText(/Problems are being collected/)).toBeTruthy();
    });

    test('onstate separates active-only numbers from the stalled-inclusive aggregate', async () => {
        mockFreshInstall();
        interface Snapshot {
            state: string;
            pct: number;
            eligible: number;
            activePct: number;
            activeEligible: number;
            activeRemaining: number;
        }
        const seen: Snapshot[] = [];
        render(LibraryProcessingHero, {
            props: { variant: 'setup', onstate: (s: Snapshot) => seen.push(s) },
        });
        await flush();

        const last = seen.at(-1)!;
        expect(last.state).toBe('working');

        // Aggregate spans all three headline rows, two of which can never
        // complete on a stock install — 6300 / 49578 = 13%.
        expect(last.eligible).toBe(16526 * 3);
        expect(last.pct).toBe(13);

        // 🔴 The regression this guards: a first-run gate reading `pct`/`state`
        // would keep the catalog hidden forever, because the two stalled stages
        // pin the aggregate low and stop `state` ever reaching 'done'. The
        // active-only numbers describe only the phase that is really running.
        expect(last.activeEligible).toBe(16526);
        expect(last.activePct).toBe(38);
        expect(last.activeRemaining).toBe(10226);
    });
});
