// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { haveFfmpeg } from '../helpers/have-ffmpeg';

export const appPort = Number(process.env.LIVETV_E2E_PORT || 5198);
export const proxyPort = Number(process.env.LIVETV_E2E_PROXY_PORT || 5199);
export const workerPort = Number(process.env.LIVETV_E2E_WORKER_PORT || 5197);
export const baseURL = `http://127.0.0.1:${appPort}`;
export const outDir =
    process.env.LIVETV_E2E_OUT || join(tmpdir(), `lumastra-livetv-e2e-${appPort}`);
export const stateFile = join(outDir, 'fixture.json');
export const viewerTimeoutSeconds = 12;
export const graceSeconds = 2;
export const identities = {
    alice: { username: 'livetv-e2e-alice', groups: 'Users' },
    bob: { username: 'livetv-e2e-bob', groups: 'Users' },
    admin: { username: 'livetv-e2e-admin', groups: 'Users,admin,LIVETV_HIGH_PRIORITY' },
} as const;
export type Identity = keyof typeof identities;

export function identityHeaders(identity: Identity): Record<string, string> {
    return {
        'X-Forwarded-User': identities[identity].username,
        'X-Forwarded-Groups': identities[identity].groups,
        Origin: baseURL,
    };
}

// The shared helper also covers ordinary PATH installs. The runner supplies
// absolute paths to its pinned Jellyfin binaries, which may not be on PATH.
export function haveLiveTvFfmpeg(): boolean {
    if (!process.env.FFMPEG_PATH && !process.env.FFPROBE_PATH) return haveFfmpeg();
    try {
        for (const binary of [
            process.env.FFMPEG_PATH || 'ffmpeg',
            process.env.FFPROBE_PATH || 'ffprobe',
        ]) {
            execFileSync(binary, ['-version'], { stdio: 'ignore', timeout: 10_000 });
        }
        return true;
    } catch {
        return false;
    }
}

export function dedicatedDatabaseUrl(): string {
    // On the remote runner the slot's own database arrives as TEST_DATABASE_URL.
    const url = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL;
    if (
        !url ||
        !/^lumastra_(t_[a-z0-9_]+|tests|claude_tests)$/.test(new URL(url).pathname.slice(1))
    ) {
        throw new Error(
            'Live TV E2E requires a dedicated DATABASE_URL (or TEST_DATABASE_URL) named lumastra_t_<slot> or lumastra_tests',
        );
    }
    return url;
}
