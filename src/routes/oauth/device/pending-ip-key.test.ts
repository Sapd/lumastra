// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, it } from 'vitest';
import { pendingIpKey } from './pending-ip-key';

it.each([
    ['2001:db8:abcd:12::1', '2001:0db8:abcd:0012::/64'],
    ['2001:0DB8:ABCD:0012:FFFF:FFFF:FFFF:FFFF', '2001:0db8:abcd:0012::/64'],
    ['2001:db8::', '2001:0db8:0000:0000::/64'],
    ['::1', '0000:0000:0000:0000::/64'],
    ['::ffff:192.0.2.1', '192.0.2.1'],
    ['::FFFF:c000:0202', '192.0.2.2'],
    ['192.0.2.1', '192.0.2.1'],
    ['unknown', 'unknown'],
])('canonicalizes pending budget IP %s', (ip, expected) => {
    expect(pendingIpKey(ip)).toBe(expected);
});
