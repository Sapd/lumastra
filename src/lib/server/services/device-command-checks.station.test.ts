// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
const { resolve, canStream } = vi.hoisted(() => ({ resolve: vi.fn(), canStream: vi.fn() }));
vi.mock('$lib/server/auth/livetv-user-policy.js', () => ({
    userAllowsLiveTv: vi.fn(async () => true),
}));
vi.mock('$lib/server/config.js', () => ({ config: { FEATURE_LIVETV: true } }));
vi.mock('$lib/server/services/livetv/station.service.js', () => ({ resolveStation: resolve }));
vi.mock('$lib/server/services/livetv/channel-access.js', () => ({
    canStreamLiveTvChannel: canStream,
}));
vi.mock('$lib/server/services/watch-together.service.js', () => ({
    getSessionWithParticipant: vi.fn(),
    getSession: vi.fn(),
}));
vi.mock('$lib/server/services/livetv/simple-mode.service.js', () => ({ getSimpleMode: vi.fn() }));
import { deviceCommandChecks, type CommandCheckContext } from './device-command-checks.js';
const stationId = '550e8400-e29b-41d4-a716-446655440000';
const locals = { user: { username: 'alice' } };
const ctx = {
    sql: null,
    userId: 'alice-id',
    hasLiveTvPermission: true,
    locals,
} as unknown as CommandCheckContext;
beforeEach(() => {
    vi.resetAllMocks();
    resolve.mockResolvedValue({ stationId, shownFeedId: 'feed', groupId: stationId });
    canStream.mockResolvedValue(true);
});
describe('Live TV tune checks', () => {
    it('resolves the station and gates the resolved feed', async () => {
        expect(
            await deviceCommandChecks(ctx).check!({ type: 'livetv.tune', args: { stationId } }),
        ).toBeNull();
        expect(resolve).toHaveBeenCalledWith(stationId);
        expect(canStream).toHaveBeenCalledWith(locals, 'feed');
    });
    it('refuses unknown stations before gating and inaccessible shown feeds', async () => {
        resolve.mockResolvedValueOnce(null);
        expect(
            await deviceCommandChecks(ctx).check!({ type: 'livetv.tune', args: { stationId } }),
        ).toMatchObject({ kind: 'not_found' });
        expect(canStream).not.toHaveBeenCalled();
        canStream.mockResolvedValueOnce(false);
        expect(
            await deviceCommandChecks(ctx).check!({ type: 'livetv.tune', args: { stationId } }),
        ).toMatchObject({ kind: 'not_found' });
    });
    it('returns unavailable on a resolver failure', async () => {
        resolve.mockRejectedValueOnce(new Error('database offline'));
        expect(
            await deviceCommandChecks(ctx).check!({ type: 'livetv.tune', args: { stationId } }),
        ).toMatchObject({ kind: 'unavailable' });
    });
});
