// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// POST /api/v1/me/links/{provider}/authorize
// Initiates the OAuth linking flow: returns authUrl for the browser to redirect to.
// The OAuth callback (GET /oauth/links/{provider}/callback) stays unversioned + browser-session.
// Auth: {kind:'user'} — self-scoped.

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/user/links/authorize.js';

export const { POST } = mount(def, { surface: 'v1' });
