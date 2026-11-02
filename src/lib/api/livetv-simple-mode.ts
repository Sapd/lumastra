// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Frontend API client for Live TV simple mode (own account and, for admins,
 * another user's).
 */

import { z } from 'zod';
import { apiGet, apiPost, apiPatch } from './client.js';
import {
    LiveTvSimpleModeSchema,
    type LiveTvSimpleModeUpdate,
} from '$lib/schemas/livetv-simple-mode.js';

export function getSimpleMode() {
    return apiGet('/api/livetv/simple-mode', LiveTvSimpleModeSchema);
}

export function updateSimpleMode(update: LiveTvSimpleModeUpdate) {
    return apiPatch('/api/livetv/simple-mode', LiveTvSimpleModeSchema, update);
}

/** 204 → `{ status: 204 }`; a wrong PIN is 403 with `details: 'pin_invalid'`, too many is 429. */
export function verifySimpleModePin(pin: string) {
    return apiPost('/api/livetv/simple-mode/verify-pin', z.unknown(), { pin });
}

export function getUserSimpleMode(username: string) {
    return apiGet(
        `/api/admin/users/${encodeURIComponent(username)}/livetv-simple-mode`,
        LiveTvSimpleModeSchema,
    );
}

export function updateUserSimpleMode(username: string, update: LiveTvSimpleModeUpdate) {
    return apiPatch(
        `/api/admin/users/${encodeURIComponent(username)}/livetv-simple-mode`,
        LiveTvSimpleModeSchema,
        update,
    );
}
