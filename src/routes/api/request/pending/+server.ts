// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/request/pending: the caller's requests, same `{items, page, linked?, dismissals}`
 * envelope as GET /api/v1/requests (one handler serves both surfaces).
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { mount } from '$lib/server/api/mount.js';
import { def as requests } from '$lib/server/api/defs/requests/index.js';

const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    request: requests.request!,
    handlers: { GET: requests.handlers.GET! },
});

export const { GET } = mount(def, { surface: 'internal' });
