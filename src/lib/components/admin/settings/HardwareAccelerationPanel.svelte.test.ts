// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HardwareAccelerationPanel from './HardwareAccelerationPanel.svelte';

const mocks = vi.hoisted(() => ({ metrics: vi.fn(), detect: vi.fn() }));
vi.mock('$lib/api/admin.js', () => ({ getSystemMetrics: mocks.metrics }));
vi.mock('$lib/api/client.js', () => ({ apiGet: mocks.detect }));
vi.mock('$lib/paths', () => ({ resolve: (path: string) => `/base${path}` }));

function props(over: Record<string, unknown> = {}) {
    return {
        savedValues: { GPU_ACCELERATION: 'qsv', HW_ENCODING_ENABLED: true },
        currentValues: { GPU_ACCELERATION: 'qsv', HW_ENCODING_ENABLED: true },
        envOverridesSet: new Set<string>(),
        handleChange: vi.fn(),
        ...over,
    };
}
function metrics(configured = 'qsv', accessible = true) {
    return {
        data: {
            hostname: 'replica-a',
            ffmpegVersion: '7.1',
            gpu: {
                configured,
                accessible,
                detected: configured !== 'none',
                name: configured !== 'none' ? 'Intel Arc' : undefined,
            },
        },
    };
}
const recommendation = {
    ffmpegReady: true,
    recommended: 'qsv',
    recommendedVendor: 'Intel',
    candidates: [{ accel: 'qsv', vendor: 'Intel', encoder: 'h264_qsv', works: true }],
};
afterEach(cleanup);
beforeEach(() => {
    mocks.metrics.mockReset();
    mocks.detect.mockReset();
    mocks.metrics.mockResolvedValue(metrics());
    mocks.detect.mockResolvedValue({ data: recommendation });
});

describe('hardware discovery and saved configuration', () => {
    it('shows the detected model, saved encoder verification, replica and retrieval time', async () => {
        render(HardwareAccelerationPanel, props());
        await screen.findByText('Intel Arc');
        expect(screen.getByTestId('hardware-verification').textContent).toContain(
            'probe succeeded',
        );
        expect(screen.getByText(/Responding replica: replica-a/).textContent).toContain(
            'Result retrieved:',
        );
        expect(screen.getByText(/up to 30 seconds/)).toBeTruthy();
        expect(
            screen
                .getByRole('link', { name: 'View GPU activity & diagnostics' })
                .getAttribute('href'),
        ).toBe('/base/admin/system/health?tab=cluster#hardware-encoder-check');
    });
    it('preserves last good result and exposes retry after a failed refresh', async () => {
        render(HardwareAccelerationPanel, props());
        await screen.findByText('Intel Arc');
        mocks.metrics.mockResolvedValueOnce({ error: 'unavailable' });
        await fireEvent.click(screen.getByRole('button', { name: 'Test saved encoder' }));
        await screen.findByRole('alert');
        expect(screen.getByText('Intel Arc')).toBeTruthy();
        await fireEvent.click(screen.getByRole('button', { name: 'Test saved encoder' }));
        await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    });
    it('requires explicit staging and uses the single form change handler', async () => {
        const p = props({
            currentValues: { GPU_ACCELERATION: 'none', HW_ENCODING_ENABLED: false },
            savedValues: { GPU_ACCELERATION: 'none', HW_ENCODING_ENABLED: false },
        });
        const { rerender } = render(HardwareAccelerationPanel, p);
        await fireEvent.click(screen.getByRole('button', { name: 'Detect hardware' }));
        await screen.findByText(/Detected recommendation: QSV/);
        expect(p.handleChange).not.toHaveBeenCalled();
        expect(screen.getByText(/h264_qsv/)).toBeTruthy();
        await fireEvent.click(screen.getByRole('button', { name: 'Apply recommendation' }));
        expect(p.handleChange.mock.calls).toEqual([
            ['GPU_ACCELERATION', 'qsv'],
            ['HW_ENCODING_ENABLED', true],
        ]);
        await rerender({
            ...p,
            currentValues: { GPU_ACCELERATION: 'qsv', HW_ENCODING_ENABLED: true },
        });
        expect(screen.getByRole('status').textContent).toContain('Save Changes');
        await rerender(p);
        expect(screen.queryByRole('status')).toBeNull();
        expect(
            (screen.getByRole('button', { name: 'Apply recommendation' }) as HTMLButtonElement)
                .disabled,
        ).toBe(false);
        await fireEvent.click(screen.getByRole('button', { name: 'Apply recommendation' }));
        expect(p.handleChange).toHaveBeenCalledTimes(4);
    });
    it('stages only the unlocked toggle when the locked encoder matches', async () => {
        const p = props({
            envOverridesSet: new Set(['GPU_ACCELERATION']),
            currentValues: { GPU_ACCELERATION: 'qsv', HW_ENCODING_ENABLED: false },
            savedValues: { GPU_ACCELERATION: 'qsv', HW_ENCODING_ENABLED: false },
        });
        render(HardwareAccelerationPanel, p);
        await fireEvent.click(screen.getByRole('button', { name: 'Detect hardware' }));
        await screen.findByText(/Detected recommendation: QSV/);
        await fireEvent.click(screen.getByRole('button', { name: 'Apply recommendation' }));
        expect(p.handleChange.mock.calls).toEqual([['HW_ENCODING_ENABLED', true]]);
        expect(screen.getByTestId('hardware-env-lock').textContent).toContain('restart');
    });
    it('cannot apply a recommendation over a different environment-owned encoder', async () => {
        const p = props({
            savedValues: { GPU_ACCELERATION: 'none', HW_ENCODING_ENABLED: false },
            currentValues: { GPU_ACCELERATION: 'none', HW_ENCODING_ENABLED: false },
            envOverridesSet: new Set(['GPU_ACCELERATION']),
        });
        render(HardwareAccelerationPanel, p);
        await fireEvent.click(screen.getByRole('button', { name: 'Detect hardware' }));
        await screen.findByText(/Detected recommendation: QSV/);
        expect(
            (screen.getByRole('button', { name: 'Apply recommendation' }) as HTMLButtonElement)
                .disabled,
        ).toBe(true);
        expect(p.handleChange).not.toHaveBeenCalled();
    });
    it('labels pending edits without claiming they have been verified', async () => {
        render(
            HardwareAccelerationPanel,
            props({ currentValues: { GPU_ACCELERATION: 'nvenc', HW_ENCODING_ENABLED: true } }),
        );
        await screen.findByTestId('hardware-verification');
        expect(screen.getByTestId('hardware-pending').textContent).toContain(
            'not the pending selection',
        );
        expect(screen.getByTestId('hardware-verification').textContent).toContain('(QSV)');
        expect(screen.getByTestId('hardware-verification').textContent).not.toContain('NVENC');
    });
    it('does not mistake a CPU-only probe for absence of physical hardware', async () => {
        mocks.metrics.mockResolvedValue(metrics('none'));
        render(
            HardwareAccelerationPanel,
            props({
                savedValues: { GPU_ACCELERATION: 'none' },
                currentValues: { GPU_ACCELERATION: 'none' },
            }),
        );
        await screen.findByText('Not checked — detect hardware');
        expect(screen.getByText(/Direct play and stream copy need no GPU/)).toBeTruthy();
    });
    it.each([
        [{ error: 'network' }, /GPU detection failed/],
        [{ data: { ffmpegReady: false, recommended: null } }, /FFmpeg is unavailable/],
        [
            {
                data: {
                    ffmpegReady: true,
                    recommended: null,
                    inContainer: true,
                    driPresent: false,
                },
            },
            /No working NVENC/,
        ],
    ])('distinguishes detection failure, missing FFmpeg and no GPU', async (response, expected) => {
        mocks.detect.mockResolvedValue(response);
        const p = props();
        render(HardwareAccelerationPanel, p);
        await fireEvent.click(screen.getByRole('button', { name: 'Detect hardware' }));
        await screen.findByText(expected);
        if (
            'data' in response &&
            response.data &&
            'inContainer' in response.data &&
            response.data.inContainer
        )
            expect(screen.getByText(/no \/dev\/dri render device/)).toBeTruthy();
        expect(p.handleChange).not.toHaveBeenCalled();
    });
});

describe('recommendation state and source', () => {
    it('does not claim changes or invoke handleChange for an already saved recommendation', async () => {
        const p = props();
        render(HardwareAccelerationPanel, p);
        await fireEvent.click(screen.getByRole('button', { name: 'Detect hardware' }));
        await screen.findByText(/already matches/);
        expect(
            (screen.getByRole('button', { name: 'Apply recommendation' }) as HTMLButtonElement)
                .disabled,
        ).toBe(true);
        expect(p.handleChange).not.toHaveBeenCalled();
        expect(screen.getByRole('status').textContent).toContain('already matches');
        expect(screen.queryByText(/Changes are ready to review/)).toBeNull();
    });
    it('blocks recommendation application when environment disables hardware encoding', async () => {
        const p = props({
            currentValues: { GPU_ACCELERATION: 'none', HW_ENCODING_ENABLED: false },
            envOverridesSet: new Set(['HW_ENCODING_ENABLED']),
        });
        render(HardwareAccelerationPanel, p);
        await fireEvent.click(screen.getByRole('button', { name: 'Detect hardware' }));
        await screen.findByText(/Detected recommendation/);
        expect(screen.getByTestId('hardware-encoding-lock').textContent).toContain('restart');
        expect(
            (screen.getByRole('button', { name: 'Apply recommendation' }) as HTMLButtonElement)
                .disabled,
        ).toBe(true);
        expect(p.handleChange).not.toHaveBeenCalled();
    });
    it('shows failed candidates and detection replica independently of status replica', async () => {
        mocks.detect.mockResolvedValue({
            data: {
                ...recommendation,
                recommended: null,
                hostname: 'replica-b',
                candidates: [{ accel: 'qsv', encoder: 'h264_qsv', vendor: 'Intel', works: false }],
            },
        });
        render(HardwareAccelerationPanel, props());
        await fireEvent.click(screen.getByRole('button', { name: 'Detect hardware' }));
        await screen.findByText(/Detection replica: replica-b/);
        expect(screen.getByText(/h264_qsv/)).toBeTruthy();
        expect(screen.getByText(/AMF and VideoToolbox require manual selection/)).toBeTruthy();
        expect(screen.getByText(/Responding replica: replica-a/)).toBeTruthy();
    });
    it('marks a result for another saved encoder unmatched', async () => {
        mocks.metrics.mockResolvedValue(metrics('nvenc'));
        render(HardwareAccelerationPanel, props());
        await screen.findByTestId('hardware-unmatched');
        expect(screen.getByTestId('hardware-verification').textContent).not.toContain(
            'probe succeeded',
        );
    });
    it('distinguishes a failed configured probe from an unattempted CPU inventory', async () => {
        mocks.metrics.mockResolvedValue({
            data: {
                hostname: 'replica-a',
                gpu: {
                    configured: 'qsv',
                    accessible: false,
                    detected: false,
                    advisory: 'Check device permissions',
                },
            },
        });
        render(HardwareAccelerationPanel, props());
        await screen.findByText(/Configured encoder probe failed/);
        expect(screen.getByText('Check device permissions')).toBeTruthy();
    });
});
