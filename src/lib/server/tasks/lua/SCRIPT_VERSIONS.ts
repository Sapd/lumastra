// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

export const SCRIPT_VERSIONS = {
    'transition-run': 4,
    'transition-stage': 2,
    'increment-stage': 2,
    'claim-run': 3,
    'reseed-for-retry': 3,
    'enqueue-with-identity': 2,
    'release-identity': 1,
    'refresh-identity': 1,
    'aging-sweep': 2,
} as const;

export type LuaScriptName = keyof typeof SCRIPT_VERSIONS;

// Shared prefix composed with every task Lua source at invocation time.
export const OWNERSHIP_FENCE_VERSION = 1;
