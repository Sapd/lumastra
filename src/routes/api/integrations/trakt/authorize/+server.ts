// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { mount } from '$lib/server/api/mount.js';
import { traktAuthorizeDef } from '$lib/server/api/defs/integrations/trakt/authorize.js';

export const { POST } = mount(traktAuthorizeDef, { surface: 'internal' });
