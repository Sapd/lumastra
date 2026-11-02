// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { request, expect } from '@playwright/test';
import postgres from 'postgres';
import {
    baseURL,
    identities,
    identityHeaders,
    outDir,
    stateFile,
    haveLiveTvFfmpeg,
    dedicatedDatabaseUrl,
} from './env';
import { expectStatus, json } from './harness';
import type { FixtureState, SourceReady, Station } from './harness';
import type { Identity } from './env';

export default async function globalSetup(): Promise<(() => Promise<void>) | undefined> {
    if (!haveLiveTvFfmpeg()) return undefined;
    const sql = postgres(dedicatedDatabaseUrl(), { max: 1 });
    try {
        // Only identity/bootstrap rows are seeded directly. The lineup, EPG,
        // favourites, simple mode, and playback all go through real HTTP APIs.
        for (const [identity, user] of Object.entries(identities)) {
            await sql`
                INSERT INTO users (username, is_admin, groups, groups_updated_at)
                VALUES (${user.username}, ${identity === 'admin'}, ${user.groups.split(',')}, NOW())
                ON CONFLICT (username) DO UPDATE SET
                    is_admin = EXCLUDED.is_admin, groups = EXCLUDED.groups,
                    groups_updated_at = NOW(), deleted_at = NULL
            `;
        }
    } finally {
        await sql.end();
    }
    await mkdir(outDir, { recursive: true });
    const admin = await request.newContext({
        baseURL,
        extraHTTPHeaders: identityHeaders('admin'),
        timeout: 60_000,
    });
    const child = spawn(process.execPath, ['scripts/livetv-testsource/server.mjs'], {
        env: {
            ...process.env,
            PORT: '0',
            HOST: '127.0.0.1',
            PUBLIC_BASE_URL: '',
            PROVIDER_MAX_CONNECTIONS: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stderr: Buffer[] = [];
    child.stderr.on('data', (data: Buffer): void => {
        stderr.push(data);
    });
    let sourceId: string | undefined;
    let provider: SourceReady | undefined;
    const cleanup = async (): Promise<void> => {
        try {
            if (provider) {
                try {
                    const status = await fetch(`${provider.baseUrl}/__status`, {
                        signal: AbortSignal.timeout(5000),
                    });
                    await writeFile(join(outDir, 'provider-status.json'), await status.text());
                } catch (error) {
                    console.error('Could not capture final provider status', error);
                }
            }
            if (sourceId)
                await expectStatus(
                    await admin.delete(`/api/admin/livetv/sources/${sourceId}`),
                    200,
                );
        } finally {
            try {
                if (child.exitCode === null && child.signalCode === null) {
                    await new Promise<void>((resolve): void => {
                        const timer = setTimeout((): void => {
                            child.kill('SIGKILL');
                            resolve();
                        }, 5000);
                        child.once('close', (): void => {
                            clearTimeout(timer);
                            resolve();
                        });
                        child.kill('SIGTERM');
                    });
                }
                await writeFile(join(outDir, 'provider.log'), Buffer.concat(stderr));
            } finally {
                await admin.dispose();
            }
        }
    };
    try {
        provider = await new Promise<SourceReady>((resolve, reject): void => {
            const lines = createInterface({ input: child.stdout });
            const timer = setTimeout((): void => {
                reject(new Error('Synthetic provider readiness timed out'));
            }, 15_000);
            const finish = (): void => {
                clearTimeout(timer);
                lines.close();
            };
            child.once('error', (error: Error): void => {
                finish();
                reject(error);
            });
            child.once('exit', (code): void => {
                finish();
                reject(
                    new Error(
                        `Synthetic provider exited ${code}: ${Buffer.concat(stderr).toString()}`,
                    ),
                );
            });
            lines.once('line', (line: string): void => {
                finish();
                try {
                    resolve(JSON.parse(line) as SourceReady);
                } catch (error) {
                    reject(error);
                }
            });
        });
        await expect
            .poll(async (): Promise<number> => (await admin.get('/api/me/pats')).status(), {
                timeout: 90_000,
                intervals: [500, 1000],
                message: 'seeded admin authenticated after bootstrap cache expires',
            })
            .toBe(200);
        // Remove this harness's leftovers, never unrelated sources or tokens.
        const old = await json<{ sources: { id: string; name: string }[] }>(
            await admin.get('/api/admin/livetv/sources'),
        );
        for (const source of old.sources.filter((item) =>
            item.name.startsWith('Live TV E2E synthetic'),
        )) {
            await expectStatus(await admin.delete(`/api/admin/livetv/sources/${source.id}`), 200);
        }
        for (const identity of Object.keys(identities) as Identity[]) {
            const client = await request.newContext({
                baseURL,
                extraHTTPHeaders: identityHeaders(identity),
            });
            try {
                const tokens = await json<{ items: { id: number; name: string }[] }>(
                    await client.get('/api/me/pats'),
                );
                for (const token of tokens.items.filter((item) =>
                    item.name.startsWith('livetv-e2e-'),
                )) {
                    await expectStatus(await client.delete(`/api/me/pats/${token.id}`), 204);
                }
                await expectStatus(
                    await client.patch('/api/livetv/simple-mode', {
                        data: {
                            enabled: false,
                            locked: false,
                            stationIds: [],
                            clearStartStation: true,
                        },
                    }),
                    200,
                );
            } finally {
                await client.dispose();
            }
        }
        const created = await json<{ source: { id: string }; taskIds?: { m3u: string } }>(
            await admin.post('/api/admin/livetv/sources', {
                data: {
                    name: 'Live TV E2E synthetic',
                    sourceType: 'm3u',
                    m3uUrl: provider.m3uUrl,
                    xmltvUrl: provider.xmltvUrl,
                    maxStreams: 1,
                },
            }),
            201,
        );
        sourceId = created.source.id;
        // Creation enqueues the real M3U import (which starts EPG as its child).
        // Do not enqueue a second import while the first is replacing feed IDs.
        if (!created.taskIds?.m3u) {
            await expectStatus(
                await admin.post(`/api/admin/livetv/sources/${sourceId}/import`),
                200,
            );
        }
        let stations: Station[] = [];
        await expect
            .poll(
                async (): Promise<number> => {
                    const result = await json<{ items: Station[] }>(
                        await admin.get('/api/livetv/stations'),
                    );
                    stations = result.items.filter((station) => station.sourceId === sourceId);
                    return stations.length;
                },
                {
                    timeout: 180_000,
                    intervals: [500, 1000, 2000],
                    message: 'real M3U task imports four stations',
                },
            )
            .toBe(4);
        const query = new URLSearchParams({
            from: new Date(Date.now() - 60_000).toISOString(),
            to: new Date(Date.now() + 3600_000).toISOString(),
            stationIds: stations.map((station) => station.id).join(','),
        });
        await expect
            .poll(
                async (): Promise<number> => {
                    const guide = await json<{ stations: { airings: unknown[] }[] }>(
                        await admin.get(`/api/livetv/guide?${query}`),
                    );
                    return guide.stations.filter((station) => station.airings.length > 0).length;
                },
                {
                    timeout: 180_000,
                    intervals: [1000, 2000],
                    message: 'real XMLTV child task populates every station',
                },
            )
            .toBe(4);
        const fixture: FixtureState = { provider, sourceId, stations };
        await writeFile(stateFile, JSON.stringify(fixture, null, 2), { mode: 0o600 });
        console.log(`[livetv-e2e] provider ${provider.baseUrl}; artifacts ${outDir}`);
        return cleanup;
    } catch (error) {
        try {
            await cleanup();
        } catch (cleanupError) {
            console.error('Live TV setup cleanup failed', cleanupError);
        }
        throw error;
    }
}
