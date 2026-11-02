// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Node `--import` bootstrap that registers the `.lua?raw` text loader (see
// tsx-lua-loader.mjs). Applied to the tsx-over-source entrypoints (start.sh,
// the migrate/openapi npm scripts) so a chain reaching the Lua loader doesn't
// crash with ERR_UNKNOWN_FILE_EXTENSION. Composes with tsx's own TS loader —
// this hook only claims `*.lua` specifiers and delegates everything else.

import { register } from 'node:module';

register('./tsx-lua-loader.mjs', import.meta.url);
