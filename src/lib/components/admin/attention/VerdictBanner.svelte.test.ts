// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * Admin IA redesign, spec §3.1: the Home verdict banner maps the canonical
 * verdict + open-item count to three plain-word states and shows the worst
 * item title (degraded/critical) or the live fact (healthy) as the subtitle.
 */

import { render, screen, cleanup, fireEvent } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as m from '$lib/paraglide/messages.js';
import VerdictBanner from './VerdictBanner.svelte';

const NOW = '2026-07-10T12:00:00.000Z';

afterEach(cleanup);

describe('VerdictBanner', () => {
    it('healthy → "Everything is healthy" + the live fact, no worst title', () => {
        render(VerdictBanner, {
            verdict: 'healthy',
            attentionCount: 0,
            worstTitle: 'should be ignored',
            greenFact: '42 tasks ran today',
            generatedAt: NOW,
        });
        expect(screen.getByText(m.admin_home_verdict_healthy())).toBeTruthy();
        expect(screen.getByText('42 tasks ran today')).toBeTruthy();
        expect(screen.queryByText('should be ignored')).toBeNull();
    });

    it('degraded → "N things need your attention" + worst item title', () => {
        render(VerdictBanner, {
            verdict: 'degraded',
            attentionCount: 3,
            worstTitle: 'Calendar sync hasn’t run for 7 days',
            greenFact: 'ignored on degraded',
            generatedAt: NOW,
        });
        expect(screen.getByText(m.admin_home_verdict_attention({ count: 3 }))).toBeTruthy();
        expect(screen.getByText('Calendar sync hasn’t run for 7 days')).toBeTruthy();
        expect(screen.queryByText('ignored on degraded')).toBeNull();
    });

    it('critical → "Something is broken" + worst item title', () => {
        render(VerdictBanner, {
            verdict: 'critical',
            attentionCount: 1,
            worstTitle: 'Database is unreachable',
            generatedAt: NOW,
        });
        expect(screen.getByText(m.admin_home_verdict_broken())).toBeTruthy();
        expect(screen.getByText('Database is unreachable')).toBeTruthy();
    });

    it('clicking the banner scrolls to the attention list', async () => {
        const onScrollToList = vi.fn();
        render(VerdictBanner, {
            verdict: 'healthy',
            attentionCount: 0,
            generatedAt: NOW,
            onScrollToList,
        });
        await fireEvent.click(screen.getByRole('button'));
        expect(onScrollToList).toHaveBeenCalledOnce();
    });
});
