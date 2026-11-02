// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { mount } from '$lib/server/api/mount.js';
import { def } from './handlers.js';
import { withAISuggestionRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';
export const GET = withAISuggestionRateLimit(mount(def, { surface: 'internal' }).GET!);
