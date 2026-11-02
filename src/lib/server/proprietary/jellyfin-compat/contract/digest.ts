// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.
import digestJson from '../../../../../../tests/jellyfin-contract/jellyfin-contract.json';
import allowlistJson from '../../../../../../tests/jellyfin-contract/allowlist.json';
import type { ContractDigest } from './build-digest';
import type { AllowEntry } from './validate';

export function getContractDigest(): ContractDigest {
    return digestJson as unknown as ContractDigest;
}
export function getAllowlist(): AllowEntry[] {
    return allowlistJson as AllowEntry[];
}
