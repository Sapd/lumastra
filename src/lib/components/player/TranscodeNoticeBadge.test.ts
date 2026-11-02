// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import * as m from '$lib/paraglide/messages.js';
import TranscodeNoticeBadge from './TranscodeNoticeBadge.svelte';

describe('TranscodeNoticeBadge', () => {
    afterEach(cleanup);

    it('renders nothing while the encoder keeps up', () => {
        const { queryByRole } = render(TranscodeNoticeBadge, { props: { notice: null } });
        expect(queryByRole('status')).toBeNull();
    });

    it.each([
        ['gpu_busy', m.player_notice_encoder_busy()],
        ['cpu_slow', m.player_notice_cpu_slow()],
        ['software_fallback', m.player_notice_software_fallback()],
        ['software_fallback_slow', m.player_notice_software_fallback_slow()],
    ] as const)('shows the %s notice as a polite status line', (notice, text) => {
        const { getByRole } = render(TranscodeNoticeBadge, { props: { notice } });
        const status = getByRole('status');
        expect(status.textContent?.trim()).toBe(text);
        expect(status.getAttribute('aria-live')).toBe('polite');
    });

    it('the busy-encoder wording names the cause and stays calm', () => {
        const { getByRole } = render(TranscodeNoticeBadge, { props: { notice: 'gpu_busy' } });
        expect(getByRole('status').textContent).toContain('another app may be using it');
    });

    it('clears when the server says the speed recovered', async () => {
        const view = render(TranscodeNoticeBadge, { props: { notice: 'gpu_busy' } });
        expect(view.queryByRole('status')).not.toBeNull();
        await view.rerender({ notice: null });
        expect(view.queryByRole('status')).toBeNull();
    });
});
