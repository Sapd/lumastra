// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit Tests for ResourceMonitor Utilities
 *
 * Tests resource monitoring functions:
 * - Process CPU/memory usage via ps command
 * - Intel GPU usage via intel_gpu_top
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExecException } from 'child_process';

// Create mock for the promisified exec function
const mockExecAsync =
    vi.fn<(cmd: string, options?: object) => Promise<{ stdout: string; stderr: string }>>();

// Mock util.promisify to return our mock when promisifying exec
vi.mock('util', async (importOriginal) => {
    const original = await importOriginal<Record<string, unknown>>();
    return {
        ...original,
        promisify: () => {
            // Return our mock for exec
            return mockExecAsync;
        },
    };
});

// Mock child_process (required for the import, but we're mocking at promisify level)
vi.mock('child_process', () => ({
    exec: vi.fn(),
}));

// Import after mocks are set up
const { getProcessResourceUsage, getIntelGpuVideoUsage } = await import('./resource-monitor.js');

const mockExecSuccess = (stdout: string, stderr: string = '') => {
    mockExecAsync.mockResolvedValue({ stdout, stderr });
};

const mockExecFailure = (error: Error) => {
    mockExecAsync.mockRejectedValue(error);
};

describe('ResourceMonitor', () => {
    beforeEach(() => {
        mockExecAsync.mockReset();
    });

    // ========================================================================
    // getProcessResourceUsage() Tests
    // ========================================================================

    describe('getProcessResourceUsage()', () => {
        it('should parse valid ps output', async () => {
            // Mock ps output: "25.5 524288" (25.5% CPU, 524288 KB RSS)
            mockExecSuccess('25.5 524288');

            const result = await getProcessResourceUsage(12345);

            expect(result.cpuPercent).toBe(25.5);
            expect(result.memoryMB).toBeCloseTo(512, 1); // 524288 KB / 1024 = 512 MB
        });

        it('should handle low CPU and memory values', async () => {
            // Low usage: 0.3% CPU, 1024 KB RSS
            mockExecSuccess(' 0.3  1024');

            const result = await getProcessResourceUsage(99999);

            expect(result.cpuPercent).toBe(0.3);
            expect(result.memoryMB).toBeCloseTo(1, 2);
        });

        it('should handle high CPU values', async () => {
            // High CPU usage: 150.2% (multi-threaded), 2048 MB
            mockExecSuccess('150.2 2097152');

            const result = await getProcessResourceUsage(54321);

            expect(result.cpuPercent).toBe(150.2);
            expect(result.memoryMB).toBeCloseTo(2048, 0);
        });

        it('should return empty object if ps output is invalid', async () => {
            // Invalid output - only one value
            mockExecSuccess('25.5');

            const result = await getProcessResourceUsage(12345);

            expect(result).toEqual({});
        });

        it('should return empty object if ps output is empty', async () => {
            mockExecSuccess('');

            const result = await getProcessResourceUsage(12345);

            expect(result).toEqual({});
        });

        it('should handle non-numeric CPU value', async () => {
            mockExecSuccess('invalid 1024');

            const result = await getProcessResourceUsage(12345);

            expect(result.cpuPercent).toBeUndefined();
            expect(result.memoryMB).toBeCloseTo(1, 2);
        });

        it('should handle non-numeric memory value', async () => {
            mockExecSuccess('25.5 invalid');

            const result = await getProcessResourceUsage(12345);

            expect(result.cpuPercent).toBe(25.5);
            expect(result.memoryMB).toBeUndefined();
        });

        it('should return empty object if process not found', async () => {
            // ps returns error code when process doesn't exist
            mockExecFailure(new Error('No such process') as ExecException);

            const result = await getProcessResourceUsage(99999);

            expect(result).toEqual({});
        });

        it('should return empty object if ps command fails', async () => {
            mockExecFailure(new Error('ps command failed') as ExecException);

            const result = await getProcessResourceUsage(12345);

            expect(result).toEqual({});
        });

        it('should handle whitespace in ps output', async () => {
            // Extra whitespace and newlines
            mockExecSuccess('  12.3    2048  \n');

            const result = await getProcessResourceUsage(12345);

            expect(result.cpuPercent).toBe(12.3);
            expect(result.memoryMB).toBeCloseTo(2, 2);
        });
    });

    // ========================================================================
    // getIntelGpuVideoUsage() Tests
    // ========================================================================

    describe('getIntelGpuVideoUsage()', () => {
        it('should parse valid intel_gpu_top JSON with Video/0 engine', async () => {
            const jsonOutput = JSON.stringify({
                engines: {
                    'Video/0': { busy: 45.67 },
                },
            });

            mockExecSuccess(jsonOutput);

            const result = await getIntelGpuVideoUsage();

            expect(result).toBe(45.7); // Rounded to 1 decimal
        });

        it('should parse valid JSON with Video engine', async () => {
            const jsonOutput = JSON.stringify({
                engines: {
                    Video: { busy: 78.92 },
                },
            });

            mockExecSuccess(jsonOutput);

            const result = await getIntelGpuVideoUsage();

            expect(result).toBe(78.9);
        });

        it('should parse valid JSON with VideoEnhance/0 engine', async () => {
            const jsonOutput = JSON.stringify({
                engines: {
                    'VideoEnhance/0': { busy: 23.45 },
                },
            });

            mockExecSuccess(jsonOutput);

            const result = await getIntelGpuVideoUsage();

            expect(result).toBe(23.5);
        });

        it('should parse valid JSON with VideoEnhance engine', async () => {
            const jsonOutput = JSON.stringify({
                engines: {
                    VideoEnhance: { busy: 99.99 },
                },
            });

            mockExecSuccess(jsonOutput);

            const result = await getIntelGpuVideoUsage();

            expect(result).toBe(100.0); // Rounded to 100.0
        });

        it('should prioritize Video/0 over Video', async () => {
            // If multiple engines exist, Video/0 should be checked first
            const jsonOutput = JSON.stringify({
                engines: {
                    'Video/0': { busy: 30.0 },
                    Video: { busy: 50.0 },
                },
            });

            mockExecSuccess(jsonOutput);

            const result = await getIntelGpuVideoUsage();

            expect(result).toBe(30.0); // Should return Video/0 value
        });

        it('should handle zero GPU usage', async () => {
            const jsonOutput = JSON.stringify({
                engines: {
                    'Video/0': { busy: 0.0 },
                },
            });

            mockExecSuccess(jsonOutput);

            const result = await getIntelGpuVideoUsage();

            expect(result).toBe(0.0);
        });

        it('should round to 1 decimal place correctly', async () => {
            const jsonOutput = JSON.stringify({
                engines: {
                    Video: { busy: 12.3456789 },
                },
            });

            mockExecSuccess(jsonOutput);

            const result = await getIntelGpuVideoUsage();

            expect(result).toBe(12.3);
        });

        it('should return undefined if stdout is empty', async () => {
            mockExecSuccess('');

            const result = await getIntelGpuVideoUsage();

            expect(result).toBeUndefined();
        });

        it('should return undefined if JSON is invalid', async () => {
            mockExecSuccess('not valid json');

            const result = await getIntelGpuVideoUsage();

            expect(result).toBeUndefined();
        });

        it('should return undefined if engines object is missing', async () => {
            const jsonOutput = JSON.stringify({
                someOtherField: 'value',
            });

            mockExecSuccess(jsonOutput);

            const result = await getIntelGpuVideoUsage();

            expect(result).toBeUndefined();
        });

        it('should return undefined if no video engine found', async () => {
            const jsonOutput = JSON.stringify({
                engines: {
                    Render: { busy: 50.0 },
                    Blitter: { busy: 10.0 },
                    // No Video or VideoEnhance engines
                },
            });

            mockExecSuccess(jsonOutput);

            const result = await getIntelGpuVideoUsage();

            expect(result).toBeUndefined();
        });

        it('should return undefined if engine busy value is missing', async () => {
            const jsonOutput = JSON.stringify({
                engines: {
                    'Video/0': {},
                    // busy field is missing
                },
            });

            mockExecSuccess(jsonOutput);

            const result = await getIntelGpuVideoUsage();

            expect(result).toBeUndefined();
        });

        it('should return undefined if intel_gpu_top command fails', async () => {
            mockExecFailure(new Error('Command not found') as ExecException);

            const result = await getIntelGpuVideoUsage();

            expect(result).toBeUndefined();
        });

        it('should call intel_gpu_top with correct arguments', async () => {
            const jsonOutput = JSON.stringify({
                engines: {
                    Video: { busy: 50.0 },
                },
            });

            mockExecSuccess(jsonOutput);

            await getIntelGpuVideoUsage();

            expect(mockExecAsync).toHaveBeenCalledWith(
                'timeout 2 intel_gpu_top -J -s 1 2>/dev/null | head -2 | tail -1',
                { timeout: 3000 },
            );
        });
    });
});
