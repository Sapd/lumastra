// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import {
    backgroundCpuCheckpoint,
    inBackgroundCpuTask,
    withBackgroundCpu,
} from './background-cpu-scope.js';

describe('background CPU scope', () => {
    it('checkpoints background work without affecting simultaneous playback', async () => {
        let resume!: () => void;
        const paused = new Promise<void>((resolve) => {
            resume = resolve;
        });
        const checkpoint = vi.fn(() => paused);
        const execute = vi.fn();
        const background = withBackgroundCpu(checkpoint, async () => {
            expect(inBackgroundCpuTask()).toBe(true);
            await backgroundCpuCheckpoint();
            execute();
        });
        expect(inBackgroundCpuTask()).toBe(false);
        await backgroundCpuCheckpoint();
        expect(checkpoint).toHaveBeenCalledOnce();
        expect(execute).not.toHaveBeenCalled();
        resume();
        await background;
        expect(execute).toHaveBeenCalledOnce();
    });
});
