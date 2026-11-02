// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * /api/admin/transcode-failures/session/[playSessionId]
 *
 * Cookie/forward-auth mirror of
 * `/api/v1/admin/transcode-failures/session/[playSessionId]` — see the
 * sibling `../+server.ts` doc comment for why this mirror exists.
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/admin/transcode-failures/session.js';

export const { GET } = mount(def, { surface: 'internal' });
