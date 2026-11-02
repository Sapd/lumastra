// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// POST /api/v1/auth/logout — revoke device refresh token + Jellyfin device token.
// Feature-gated: FEATURE_DEVICE_AUTH — off → 404 not_found.
// Auth: user (device JWT only; PATs log out via DELETE /me/pats/{id}).

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/auth/logout.js';

export const { POST } = mount(def, { surface: 'v1' });
