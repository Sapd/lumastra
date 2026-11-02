// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Mock IPTV fixture server for integration tests.
 * Serves continuous MPEG-TS data with ability to simulate failures.
 *
 * CRITICAL: Node.js builtins only — no npm packages.
 */
import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';

export const SEGMENT_SERVER_FRAME_RATE = 25;

interface SegmentServerOptions {
    /** Opt-in source alignment; defaults stay at 50 frames for existing/HDR fixtures. */
    keyframeIntervalFrames?: number;
}

export class SegmentServer {
    private server: http.Server | null = null;
    private paused = false;
    private connections = new Set<http.ServerResponse>();
    private producer: ChildProcess | null = null;
    private port = 0;
    private stderrTail = '';

    private readonly keyframeIntervalFrames: number;

    /**
     * `hevc-hdr`: HEVC Main 10 with HDR10 (PQ) signalling and E-AC-3 audio, the shape of a
     * UHD IPTV channel, at a small size so the encode stays realtime.
     */
    constructor(
        private readonly video: 'h264' | 'hevc-hdr' = 'h264',
        options: SegmentServerOptions = {},
    ) {
        this.keyframeIntervalFrames = options.keyframeIntervalFrames ?? 50;
        if (
            !Number.isSafeInteger(this.keyframeIntervalFrames) ||
            this.keyframeIntervalFrames < 1 ||
            this.keyframeIntervalFrames > SEGMENT_SERVER_FRAME_RATE * 60
        ) {
            throw new Error('Fixture keyframe interval must be an integer from 1 to 1500 frames');
        }
    }

    /** Start the fixture server on the given port (0 for random). */
    async start(port = 0): Promise<number> {
        return new Promise((resolve) => {
            this.server = http.createServer((req, res) => {
                if (req.url === '/stream') {
                    res.writeHead(200, {
                        'Content-Type': 'video/mp2t',
                        'Transfer-Encoding': 'chunked',
                    });
                    this.connections.add(res);
                    res.on('close', () => this.connections.delete(res));
                } else {
                    res.writeHead(404);
                    res.end();
                }
            });

            this.server.listen(port, () => {
                const addr = this.server!.address();
                this.port = typeof addr === 'object' && addr ? addr.port : port;

                this.startProducer();

                resolve(this.port);
            });
        });
    }

    /** Get the URL for this fixture server's stream. */
    get url(): string {
        return `http://127.0.0.1:${this.port}/stream`;
    }

    /** Stop sending data but keep connection (simulates hiccup). */
    pause(): void {
        this.paused = true;
        this.producer?.stdout?.pause();
    }

    /** Resume sending after pause. */
    resume(): void {
        this.paused = false;
        this.producer?.stdout?.resume();
    }

    /** Stop the server entirely (simulates primary failure). */
    async stop(): Promise<void> {
        const producer = this.producer;
        this.producer = null;
        const server = this.server;
        this.server = null;

        let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
        let safetyTimer: ReturnType<typeof setTimeout> | null = null;
        const producerStopped = new Promise<void>((resolve) => {
            if (!producer || producer.exitCode !== null || producer.signalCode !== null) {
                resolve();
                return;
            }
            producer.once('close', () => resolve());
            forceKillTimer = setTimeout(() => {
                try {
                    producer.kill('SIGKILL');
                } catch {
                    // Already gone.
                }
            }, 1_000);
            safetyTimer = setTimeout(resolve, 3_000);
            forceKillTimer.unref();
            safetyTimer.unref();
            try {
                producer.kill('SIGTERM');
            } catch {
                resolve();
            }
        });

        // Destroy all active connections
        for (const conn of this.connections) {
            conn.destroy();
        }
        this.connections.clear();

        const serverStopped = new Promise<void>((resolve) => {
            if (!server?.listening) resolve();
            else server.close(() => resolve());
        });

        await Promise.all([producerStopped, serverStopped]);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        if (safetyTimer) clearTimeout(safetyTimer);
    }

    /** Spawn a real-time A/V source so consumers exercise actual MPEG-TS demuxing. */
    private startProducer(): void {
        const ffmpegPath = process.env.FFMPEG_PATH || '/usr/bin/ffmpeg';
        const producer = spawn(
            ffmpegPath,
            [
                '-hide_banner',
                '-loglevel',
                'error',
                '-re',
                '-f',
                'lavfi',
                '-i',
                `testsrc2=size=320x180:rate=${SEGMENT_SERVER_FRAME_RATE}`,
                '-f',
                'lavfi',
                '-i',
                'sine=frequency=1000:sample_rate=48000',
                ...(this.video === 'hevc-hdr'
                    ? [
                          '-c:v',
                          'libx265',
                          '-preset',
                          'ultrafast',
                          '-pix_fmt',
                          'yuv420p10le',
                          '-x265-params',
                          `keyint=${this.keyframeIntervalFrames}:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:log-level=error`,
                          '-color_primaries',
                          'bt2020',
                          '-color_trc',
                          'smpte2084',
                          '-colorspace',
                          'bt2020nc',
                          '-c:a',
                          'eac3',
                          '-b:a',
                          '192k',
                      ]
                    : [
                          '-c:v',
                          'libx264',
                          '-preset',
                          'ultrafast',
                          '-g',
                          String(this.keyframeIntervalFrames),
                          '-pix_fmt',
                          'yuv420p',
                          '-c:a',
                          'aac',
                          '-b:a',
                          '96k',
                      ]),
                '-f',
                'mpegts',
                'pipe:1',
            ],
            { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        this.producer = producer;

        producer.stdout?.on('data', (chunk: Buffer) => {
            if (this.paused) return;
            for (const conn of this.connections) {
                if (!conn.destroyed) conn.write(chunk);
            }
        });
        producer.stderr?.on('data', (chunk: Buffer) => {
            this.stderrTail = (this.stderrTail + chunk.toString()).slice(-5000);
        });
        producer.on('error', (err) => {
            this.stderrTail = (this.stderrTail + err.message).slice(-5000);
        });
        producer.on('close', (code, signal) => {
            if (this.producer !== producer || code === 0 || signal === 'SIGTERM') return;
            console.error(
                `[SegmentServer] FFmpeg producer exited: code=${code} signal=${signal}: ${this.stderrTail}`,
            );
        });
    }
}
