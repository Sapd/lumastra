// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, expect, it, vi } from 'vitest';
const calls = vi.hoisted(() => ({
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
}));
vi.mock('./client.js', () => ({
    apiGet: calls.get,
    apiPost: calls.post,
    apiPut: calls.put,
    apiPatch: calls.patch,
    apiDelete: calls.delete,
}));
import {
    getPlaybackPreferences,
    updatePlaybackPreferences,
    getNotificationWebhook,
    setNotificationWebhook,
    clearNotificationWebhook,
    getNotificationForwarding,
    setNotificationForwarding,
    getTokens,
    deleteToken,
    getUser,
} from './user.js';
import { updatePlaylist } from './playlists.js';

beforeEach(() => {
    vi.clearAllMocks();
});
it('reads and PATCHes preferences on /me with the sparse payload unchanged', () => {
    getPlaybackPreferences();
    updatePlaybackPreferences({ subtitlesEnabled: false });
    expect(calls.get.mock.calls[0][0]).toBe('/api/me/playback-preferences');
    expect(calls.patch).toHaveBeenCalledWith('/api/me/playback-preferences', expect.anything(), {
        subtitlesEnabled: false,
    });
    expect(calls.put).not.toHaveBeenCalled();
});
it('PATCHes playlist metadata', () => {
    updatePlaylist(42, { description: 'Changed' });
    expect(calls.patch).toHaveBeenCalledWith('/api/playlists/42', expect.anything(), {
        description: 'Changed',
    });
    expect(calls.put).not.toHaveBeenCalled();
});
it('keeps webhook replacement POST and forwarding PUT on their new self paths', () => {
    getNotificationWebhook();
    setNotificationWebhook({ url: 'https://example.org/hook' });
    clearNotificationWebhook();
    getNotificationForwarding();
    setNotificationForwarding(false);
    expect(calls.get.mock.calls.map(([path]) => path)).toEqual([
        '/api/me/notification-webhook',
        '/api/me/notification-forwarding',
    ]);
    expect(calls.post.mock.calls[0][0]).toBe('/api/me/notification-webhook');
    expect(calls.delete.mock.calls[0][0]).toBe('/api/me/notification-webhook');
    expect(calls.put.mock.calls[0][0]).toBe('/api/me/notification-forwarding');
});
it('moves self PATs and keeps the differently shaped internal account resource', () => {
    getTokens();
    deleteToken('42');
    getUser();
    expect(calls.get.mock.calls.map(([path]) => path)).toEqual(['/api/me/pats', '/api/user']);
    expect(calls.delete.mock.calls[0][0]).toBe('/api/me/pats/42');
});
