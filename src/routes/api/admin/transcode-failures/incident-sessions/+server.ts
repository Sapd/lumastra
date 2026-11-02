// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * /api/admin/transcode-failures/incident-sessions
 *
 * Cookie/forward-auth mirror of `/api/v1/admin/transcode-failures/incident-sessions`
 * — see `../+server.ts`'s doc comment for why this mirror exists.
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/admin/transcode-failures/incident-sessions.js';

export const { GET } = mount(def, { surface: 'internal' });
