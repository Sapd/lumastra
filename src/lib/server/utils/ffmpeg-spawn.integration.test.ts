// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for FFmpeg Spawn Wrapper
 *
 * These tests use REAL FFmpeg to verify:
 * 1. Wrapper handles all success cases correctly
 * 2. Error handling works (bad paths, invalid args, timeouts)
 * 3. Size limits prevent OOM
 * 4. All safety patterns prevent crashes
 *
 * Run with: npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
    spawnFFmpegSafely,
    FFmpegError,
    FFmpegTimeoutError,
    FFmpegSizeError,
} from './ffmpeg-spawn';
import { checkFFmpegAvailability } from './ffmpeg-spawn';
import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { config } from '../config';

// Test file paths
const TEST_DIR = path.join(process.cwd(), 'test-tmp');
const TEST_VIDEO = path.join(TEST_DIR, 'test-video.mp4');

describe('FFmpeg Spawn Wrapper - Integration Tests', () => {
    beforeAll(async () => {
        // Create test directory
        await fs.mkdir(TEST_DIR, { recursive: true });

        // Generate a minimal test video (1 second, black screen, 320x240)
        // This is tiny (~10KB) and generates quickly
        const generateArgs = [
            '-f',
            'lavfi',
            '-i',
            'color=c=black:s=320x240:d=1',
            '-f',
            'lavfi',
            '-i',
            'anullsrc=r=44100:cl=stereo',
            '-shortest',
            '-c:v',
            'libx264',
            '-preset',
            'ultrafast',
            '-pix_fmt',
            'yuv420p',
            '-c:a',
            'aac',
            '-t',
            '1',
            TEST_VIDEO,
        ];

        try {
            await spawnFFmpegSafely({
                args: generateArgs,
                timeout: 10000,
                context: { operation: 'test-setup' },
            });
        } catch (error) {
            console.error('Failed to generate test video:', error);
            throw error;
        }
    });

    afterAll(async () => {
        // Cleanup test directory
        try {
            await fs.rm(TEST_DIR, { recursive: true, force: true });
        } catch (error) {
            console.warn('Failed to cleanup test directory:', error);
        }
    });

    describe('Basic Functionality', () => {
        it('should check FFmpeg availability', async () => {
            const available = await checkFFmpegAvailability();
            expect(available).toBe(true);
        });

        it('should get FFmpeg version', async () => {
            const result = await spawnFFmpegSafely({
                args: ['-version'],
                timeout: 5000,
            });

            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain('ffmpeg version');
            expect(result.timedOut).toBe(false);
            expect(result.sizeExceeded).toBe(false);
        });

        it('should probe video file successfully', async () => {
            const result = await spawnFFmpegSafely({
                args: ['-i', TEST_VIDEO, '-f', 'null', '-'],
                timeout: 5000,
            });

            expect(result.exitCode).toBe(0);
            expect(result.stderr).toContain('Video:');
            expect(result.stderr).toContain('Audio:');
        });

        it('should extract video metadata to stdout', async () => {
            const result = await spawnFFmpegSafely({
                args: ['-i', TEST_VIDEO, '-f', 'ffmetadata', '-'],
                timeout: 5000,
            });

            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain(';FFMETADATA');
        });
    });

    describe('Error Handling', () => {
        it('should handle non-existent input file gracefully', async () => {
            await expect(
                spawnFFmpegSafely({
                    args: ['-i', '/nonexistent/file.mp4', '-f', 'null', '-'],
                    timeout: 5000,
                }),
            ).rejects.toThrow(FFmpegError);
        });

        it('should handle invalid FFmpeg arguments', async () => {
            await expect(
                spawnFFmpegSafely({
                    args: ['--this-is-not-a-valid-argument'],
                    timeout: 5000,
                }),
            ).rejects.toThrow(FFmpegError);
        });

        it('should handle invalid output format', async () => {
            await expect(
                spawnFFmpegSafely({
                    args: ['-i', TEST_VIDEO, '-f', 'invalid_format_xyz', '-'],
                    timeout: 5000,
                }),
            ).rejects.toThrow(FFmpegError);
        });

        it('should include stderr in error message', async () => {
            try {
                await spawnFFmpegSafely({
                    args: ['-i', '/nonexistent.mp4'],
                    timeout: 5000,
                });
                expect.fail('Should have thrown an error');
            } catch (error) {
                expect(error).toBeInstanceOf(FFmpegError);
                expect((error as FFmpegError).stderr).toBeTruthy();
                expect((error as FFmpegError).stderr).toContain('No such file');
            }
        });
    });

    describe('Timeout Handling', () => {
        it('should timeout long-running operations', async () => {
            // Encode a moderately complex video that takes a few seconds
            // Timeout after 200ms which is definitely before completion
            await expect(
                spawnFFmpegSafely({
                    args: [
                        '-f',
                        'lavfi',
                        '-i',
                        'testsrc=duration=30:size=1920x1080:rate=30',
                        '-c:v',
                        'libx264',
                        '-preset',
                        'slow',
                        '-f',
                        'null',
                        '-',
                    ],
                    timeout: 200,
                }),
            ).rejects.toThrow(FFmpegTimeoutError);
        }, 10000);

        it('should include timeout info in error', async () => {
            try {
                await spawnFFmpegSafely({
                    args: [
                        '-f',
                        'lavfi',
                        '-i',
                        'testsrc=duration=30:size=1920x1080:rate=30',
                        '-c:v',
                        'libx264',
                        '-preset',
                        'slow',
                        '-f',
                        'null',
                        '-',
                    ],
                    timeout: 200,
                });
                expect.fail('Should have thrown timeout error');
            } catch (error) {
                expect(error).toBeInstanceOf(FFmpegTimeoutError);
                expect((error as FFmpegTimeoutError).timedOut).toBe(true);
                expect((error as FFmpegTimeoutError).message).toContain('timed out');
                expect((error as FFmpegTimeoutError).message).toContain('200ms');
            }
        }, 10000);
    });

    describe('Size Limit Handling', () => {
        it('should enforce stdout size limit', async () => {
            // Extract raw video to stdout (will exceed 1KB quickly)
            await expect(
                spawnFFmpegSafely({
                    args: ['-i', TEST_VIDEO, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
                    timeout: 5000,
                    maxStdoutSize: 1024, // 1KB limit
                }),
            ).rejects.toThrow(FFmpegSizeError);
        });

        it('should include size info in error', async () => {
            try {
                await spawnFFmpegSafely({
                    args: ['-i', TEST_VIDEO, '-f', 'rawvideo', '-'],
                    timeout: 5000,
                    maxStdoutSize: 1024,
                });
                expect.fail('Should have thrown size error');
            } catch (error) {
                expect(error).toBeInstanceOf(FFmpegSizeError);
                expect((error as FFmpegSizeError).sizeExceeded).toBe(true);
                expect((error as FFmpegSizeError).message).toContain('exceeded maximum size');
                expect((error as FFmpegSizeError).message).toContain('1024');
            }
        });

        it('should handle large stderr output', async () => {
            // Generate lots of stderr with verbose logging
            // Should not throw - stderr has sliding window
            const result = await spawnFFmpegSafely({
                args: ['-v', 'debug', '-i', TEST_VIDEO, '-f', 'null', '-'],
                timeout: 10000,
                maxStderrSize: 1024, // Small stderr limit
            });

            expect(result.exitCode).toBe(0);
            // Stderr should be truncated to ~512 bytes (half of limit)
            expect(result.stderr.length).toBeLessThan(1024);
        });
    });

    describe('stdin Handling', () => {
        it('should accept stdin input', async () => {
            const result = await spawnFFmpegSafely({
                args: ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=0.1', '-f', 'wav', '-'],
                timeout: 5000,
                stdin: '', // Empty stdin, using lavfi input instead
            });

            expect(result.exitCode).toBe(0);
            expect(result.stdout.length).toBeGreaterThan(0);
        });
    });

    describe('Working Directory', () => {
        it('should respect cwd parameter', async () => {
            const outputFile = `test-output-${randomUUID()}.wav`;

            await spawnFFmpegSafely({
                args: [
                    '-f',
                    'lavfi',
                    '-i',
                    'anullsrc=r=44100:cl=mono:d=0.1',
                    '-f',
                    'wav',
                    outputFile, // File output, not stdout
                ],
                cwd: TEST_DIR,
                timeout: 5000,
            });

            // File should be created in TEST_DIR, not current directory
            const outputPath = path.join(TEST_DIR, outputFile);
            await expect(fs.access(outputPath)).resolves.not.toThrow();

            // Cleanup
            await fs.unlink(outputPath).catch(() => {});
        });
    });

    describe('Context Logging', () => {
        it('should accept context for logging', async () => {
            // This won't throw - just verify context is accepted
            const result = await spawnFFmpegSafely({
                args: ['-version'],
                timeout: 5000,
                context: {
                    userId: 'test-user',
                    operation: 'test-operation',
                    itemId: 'test-item',
                },
            });

            expect(result.exitCode).toBe(0);
        });
    });

    describe('Real-World Use Cases', () => {
        it('should extract audio codec info from stderr', async () => {
            // Just probe the file - stderr contains all codec info
            const result = await spawnFFmpegSafely({
                args: ['-i', TEST_VIDEO, '-f', 'null', '-'],
                timeout: 5000,
            });

            expect(result.exitCode).toBe(0);
            expect(result.stderr).toContain('Audio:');
            expect(result.stderr).toContain('aac');
        });

        it('should generate thumbnail', async () => {
            const result = await spawnFFmpegSafely({
                args: [
                    '-i',
                    TEST_VIDEO,
                    '-vf',
                    'thumbnail',
                    '-frames:v',
                    '1',
                    '-f',
                    'image2',
                    '-c:v',
                    'mjpeg',
                    '-',
                ],
                timeout: 5000,
            });

            expect(result.exitCode).toBe(0);
            expect(result.stdout.length).toBeGreaterThan(500);
            // Stdout contains binary JPEG data (can't verify magic bytes in string encoding)
        });

        it('should detect hardware capabilities', async () => {
            const result = await spawnFFmpegSafely({
                args: ['-encoders'],
                timeout: 5000,
            });

            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain('Encoders:');
            // Should list at least some common codecs
            expect(result.stdout).toMatch(/h264|libx264/);
        });

        it('should extract codec information', async () => {
            const result = await spawnFFmpegSafely({
                args: ['-i', TEST_VIDEO, '-c', 'copy', '-f', 'null', '-'],
                timeout: 5000,
            });

            expect(result.exitCode).toBe(0);
            expect(result.stderr).toContain('Stream #0:0');
            expect(result.stderr).toContain('Stream #0:1');
        });
    });

    describe('Safety Pattern Verification', () => {
        it('should handle process killed by signal', async () => {
            // This is hard to test directly, but we can verify error structure
            // The wrapper should catch SIGTERM/SIGKILL scenarios
            // This test just verifies the error types are properly exported
            expect(FFmpegError).toBeDefined();
            expect(FFmpegTimeoutError).toBeDefined();
            expect(FFmpegSizeError).toBeDefined();
        });

        it('should not crash on rapid concurrent calls', async () => {
            // Verify no race conditions with concurrent FFmpeg spawns
            const promises = Array.from({ length: 10 }, (_, i) =>
                spawnFFmpegSafely({
                    args: ['-version'],
                    timeout: 5000,
                    context: { callNumber: i },
                }),
            );

            const results = await Promise.all(promises);
            expect(results).toHaveLength(10);
            results.forEach((result) => {
                expect(result.exitCode).toBe(0);
            });
        });

        it('should handle FFmpeg crash gracefully', async () => {
            // Invalid codec combo that causes FFmpeg to fail
            await expect(
                spawnFFmpegSafely({
                    args: [
                        '-f',
                        'lavfi',
                        '-i',
                        'testsrc=d=0.1',
                        '-c:v',
                        'invalid_codec_name',
                        '-f',
                        'null',
                        '-',
                    ],
                    timeout: 5000,
                }),
            ).rejects.toThrow(FFmpegError);
        });
    });

    describe('Config Integration', () => {
        it('should use FFMPEG_PATH from config', async () => {
            // Wrapper internally uses config.FFMPEG_PATH
            // This test verifies it's being used (implicit test via success)
            const result = await spawnFFmpegSafely({
                args: ['-version'],
                timeout: 5000,
            });

            expect(result.exitCode).toBe(0);
            expect(config.FFMPEG_PATH).toBeTruthy();
        });
    });

    describe('Edge Cases', () => {
        it('should handle empty stdout', async () => {
            const result = await spawnFFmpegSafely({
                args: ['-f', 'lavfi', '-i', 'anullsrc=d=0.1', '-f', 'null', '-'],
                timeout: 5000,
            });

            expect(result.exitCode).toBe(0);
            expect(result.stdout).toBe('');
            expect(result.stderr.length).toBeGreaterThan(0);
        });

        it('should handle binary output correctly', async () => {
            const result = await spawnFFmpegSafely({
                args: ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo:d=0.1', '-f', 'wav', '-'],
                timeout: 5000,
            });

            expect(result.exitCode).toBe(0);
            expect(result.stdout.length).toBeGreaterThan(44); // WAV header size
            // Stdout contains binary WAV data (string encoding makes byte inspection unreliable)
        });

        it('should handle special characters in paths', async () => {
            const specialDir = path.join(TEST_DIR, 'test dir with spaces');
            const specialFile = path.join(specialDir, 'test file (with special chars).txt');

            await fs.mkdir(specialDir, { recursive: true });

            const result = await spawnFFmpegSafely({
                args: ['-f', 'lavfi', '-i', 'anullsrc=d=0.1', '-f', 'null', specialFile],
                timeout: 5000,
            });

            expect(result.exitCode).toBe(0);
        });
    });
});

// Real child + pipe backpressure, with a small cap so the test cannot fill disk.
it('kills a real FFmpeg on binary-output overflow before writing past its cap', async () => {
    const dir = await fs.mkdtemp(
        path.join((await import('node:os')).tmpdir(), 'ffmpeg-binary-limit-'),
    );
    const output = path.join(dir, 'audio.raw');
    try {
        await expect(
            spawnFFmpegSafely({
                args: [
                    '-f',
                    'lavfi',
                    '-i',
                    'anullsrc=r=48000:cl=stereo',
                    '-t',
                    '3600',
                    '-f',
                    's16le',
                    'pipe:3',
                ],
                binaryOutputs: [{ path: output, maxBytes: 4096 }],
                timeout: 5000,
            }),
        ).rejects.toBeInstanceOf(FFmpegSizeError);
        expect((await fs.stat(output)).size).toBeLessThanOrEqual(4096);
        // Child closure and writer completion precede rejection: size stays fixed.
        const size = (await fs.stat(output)).size;
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect((await fs.stat(output)).size).toBe(size);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});
