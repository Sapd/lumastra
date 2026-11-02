// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/people/search.js';
import { withSearchRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';

// authz: user — the authz decision lives in the shared `def` (auth: { kind: 'user' }),
// enforced by mount(); this thin route only adds the Valkey rate-limit wrapper.
const { GET: _GET } = mount(def, { surface: 'internal' });
// Preserve the distributed Valkey-backed per-caller rate limit.
export const GET = withSearchRateLimit(_GET!);
