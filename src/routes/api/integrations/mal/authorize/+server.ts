// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { mount } from '$lib/server/api/mount.js';
import { malAuthorizeDef } from '$lib/server/api/defs/integrations/mal/authorize.js';

export const { POST } = mount(malAuthorizeDef, { surface: 'internal' });
