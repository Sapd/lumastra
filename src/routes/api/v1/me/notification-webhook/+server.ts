// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET    /api/v1/me/notification-webhook — read the caller's own endpoint
// POST   /api/v1/me/notification-webhook — set/replace it (returns the secret ONCE)
// DELETE /api/v1/me/notification-webhook — clear it
//
// The def shipped with only the `internal` mount, which left the endpoint
// unreachable by Bearer clients even though every sibling under `user/`
// (profile, playback-preferences, links, tokens) mounts on both surfaces and
// the def declares no surface preference. Self-scoping is a property of the
// def's shape — `{kind:'user'}` on every method, no user id in the path, no
// cross-user read in the query module — so it is not weakened by being
// reachable with a token rather than a session cookie.

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/user/notification-webhook.js';

export const { GET, POST, DELETE } = mount(def, { surface: 'v1' });
