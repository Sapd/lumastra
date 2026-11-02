// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { render, screen, cleanup } from '@testing-library/svelte';
import { expect, it, afterEach } from 'vitest';
import RangeMappingDiagnosis from './RangeMappingDiagnosis.svelte';
afterEach(cleanup);

it('shows dated mapping scope and collapsed participant evidence', () => {
    render(RangeMappingDiagnosis, {
        mapping: {
            state: 'current',
            proof: {
                version: 1,
                observedAt: '2026-10-25T00:00:00.000Z',
                participants: [],
            },
        },
    });
    expect(screen.getByText(/Dedicated episode mappings observed on/)).toBeTruthy();
    expect(screen.getByText(/content completeness is unverified/)).toBeTruthy();
    expect(screen.getByText('Recorded mapping details').closest('details')?.open).toBe(false);
});
it('keeps unknown coverage visible as a warning requiring review', () => {
    render(RangeMappingDiagnosis, { mapping: { state: 'unproven' } });
    expect(screen.getByText(/mappings are unproven/)).toBeTruthy();
    expect(screen.queryByText(/Dedicated episode mappings observed on/)).toBeNull();
});
