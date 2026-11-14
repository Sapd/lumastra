// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { gunzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ingest = vi.fn();
const prune = vi.fn().mockResolvedValue(0);
vi.mock('$lib/server/services/client-diagnostics/ingest.service', async (orig) => ({
    ...(await orig<object>()),
    ingestLogBundle: ingest,
}));
vi.mock('$lib/server/database/queries/client-diagnostics.queries', async (orig) => ({
    ...(await orig<object>()),
    pruneJellyfinBundlesForDevice: prune,
}));
const { storeJellyfinClientLog } = await import('./client-log-bundle');

const args = {
    userId: 'u1',
    deviceId: 'd1',
    deviceName: 'Fire TV',
    clientName: 'Jellyfin Android TV',
    clientVersion: '0.19.10',
    text: '---\nfoo: 1\n---\nstack',
    truncated: false,
};
beforeEach(() => {
    ingest.mockReset().mockResolvedValue({ ok: true, diagnosticId: 1, eventId: 'e', shortId: 's' });
    prune.mockClear();
});

describe('storeJellyfinClientLog', () => {
    it('hands the log to ingestLogBundle as gzip with server-side trigger and source', async () => {
        await storeJellyfinClientLog({} as never, args);
        const [, userId, input, server] = ingest.mock.calls[0];
        expect(userId).toBe('u1');
        expect(input).toMatchObject({
            platform: 'other',
            deviceId: 'd1',
            appVersion: '0.19.10',
            scope: 'device',
            trigger: 'user',
        });
        expect(gunzipSync(Buffer.from(input.contentGzipBase64, 'base64')).toString()).toBe(
            args.text,
        );
        expect(server).toEqual({
            trigger: 'client_upload',
            extraPayload: {
                source: 'jellyfin',
                clientName: 'Jellyfin Android TV',
                deviceName: 'Fire TV',
                truncated: false,
            },
        });
        expect(prune).toHaveBeenCalledWith(expect.anything(), 'u1', 'd1', 5);
    });

    it('the same bytes from the same device map to the same eventId (ACRA retries dedupe)', async () => {
        await storeJellyfinClientLog({} as never, args);
        await storeJellyfinClientLog({} as never, args);
        await storeJellyfinClientLog({} as never, { ...args, deviceId: 'd2' });
        const ids = ingest.mock.calls.map((c) => c[2].eventId);
        expect(ids[0]).toBe(ids[1]);
        expect(ids[2]).not.toBe(ids[0]);
    });

    it('never throws; reports the ingest refusal', async () => {
        ingest.mockResolvedValueOnce({ ok: false, reason: 'budget' });
        await expect(storeJellyfinClientLog({} as never, args)).resolves.toEqual({
            stored: false,
            reason: 'budget',
        });
        ingest.mockRejectedValueOnce(new Error('db down'));
        await expect(storeJellyfinClientLog({} as never, args)).resolves.toEqual({
            stored: false,
            reason: 'error',
        });
    });

    it('strips the sanitiser ellipsis and clamps appVersion to 32 chars', async () => {
        await storeJellyfinClientLog({} as never, { ...args, clientVersion: `${'9'.repeat(96)}…` });
        const input = ingest.mock.calls[0][2];
        expect(input.appVersion).toBe('9'.repeat(32));
        await storeJellyfinClientLog({} as never, { ...args, clientVersion: '1.2…' });
        expect(ingest.mock.calls[1][2].appVersion).toBe('1.2');
    });

    it('omits appVersion and deviceId when absent and skips pruning without a device', async () => {
        await storeJellyfinClientLog({} as never, { ...args, deviceId: null, clientVersion: null });
        const input = ingest.mock.calls[0][2];
        expect(input).not.toHaveProperty('appVersion');
        expect(input).not.toHaveProperty('deviceId');
        expect(prune).not.toHaveBeenCalled();
    });

    it('caps every line at 2000 chars and flags truncated for a 256 KiB single line', async () => {
        const text = '0123456789abcdef-'.repeat(Math.ceil((256 * 1024) / 17)).slice(0, 256 * 1024);
        await storeJellyfinClientLog({} as never, { ...args, text });
        const [, , input, server] = ingest.mock.calls[0];
        const stored = gunzipSync(Buffer.from(input.contentGzipBase64, 'base64')).toString();
        for (const line of stored.split('\n')) expect(line.length).toBeLessThanOrEqual(2020);
        expect(stored).toContain('…[truncated]');
        expect(server.extraPayload.truncated).toBe(true);
    });

    it('leaves short lines untouched and only cuts the long ones', async () => {
        const text = `short\n${'x'.repeat(5000)}\nend`;
        await storeJellyfinClientLog({} as never, { ...args, text });
        const [, , input, server] = ingest.mock.calls[0];
        const lines = gunzipSync(Buffer.from(input.contentGzipBase64, 'base64'))
            .toString()
            .split('\n');
        expect(lines[0]).toBe('short');
        expect(lines[2]).toBe('end');
        expect(lines[1]).toHaveLength(2000 + ' …[truncated]'.length);
        expect(server.extraPayload.truncated).toBe(true);
    });
});
