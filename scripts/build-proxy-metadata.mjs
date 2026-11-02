// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { writeProxyBuildId } from './livetv-proxy-inputs.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
console.log(
    `Live TV proxy build: ${writeProxyBuildId(root, resolve(root, 'build/livetv-proxy-build'))}`,
);
