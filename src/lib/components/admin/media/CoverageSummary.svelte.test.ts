// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import CoverageSummary from './CoverageSummary.svelte';
describe('coverage disclosure', () => {
    it('never describes a conflict as known missing', () => {
        render(CoverageSummary, {
            coverage: {
                episodesHeld: 3,
                episodesListed: 6,
                missing: 0,
                identified: 6,
                conflicted: true,
            },
            seasons: [
                {
                    seasonNumber: 1,
                    held: 3,
                    listed: 6,
                    catalog: 7,
                    missing: null,
                    otherIssues: 1,
                    conflicted: true,
                },
            ],
        });
        expect(screen.getByText(/Episode identities conflict/)).toBeTruthy();
        expect(screen.getByText(/Missing episodes: unknown/)).toBeTruthy();
        expect(screen.queryByText('0 missing aired episodes')).toBeNull();
    });
    it('states unknown when the provider list was not identified', () => {
        render(CoverageSummary, { coverage: null });
        expect(screen.getByText(/missing episode count is unknown/)).toBeTruthy();
    });
});

it('labels a wholly unnumbered season separately from specials', () => {
    render(CoverageSummary, {
        coverage: null,
        seasons: [
            {
                seasonNumber: null,
                held: 2,
                listed: 0,
                catalog: 3,
                missing: null,
                otherIssues: 0,
                conflicted: false,
            },
        ],
    });
    expect(screen.getByText('Season unknown')).toBeTruthy();
    expect(screen.getByText(/2 available \/ 3 catalog entries/)).toBeTruthy();
    expect(screen.queryByText('Specials')).toBeNull();
});
