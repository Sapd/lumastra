// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { render, screen } from '@testing-library/svelte';
import { expect, it } from 'vitest';
import HealthBadge from './HealthBadge.svelte';

it('distinguishes a coverage mismatch from a notice', () => {
    render(HealthBadge, { status: 'mismatch' });
    expect(screen.getByText('Episode counts differ')).toBeTruthy();
    expect(screen.queryByText('Notice')).toBeNull();
});
