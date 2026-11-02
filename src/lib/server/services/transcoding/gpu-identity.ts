// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import fs from 'node:fs';
import path from 'node:path';

/**
 * Which GPU is actually installed, read straight from sysfs.
 *
 * SYNCHRONOUS AND SPAWN-FREE by design. The existing GPU-name detection in the
 * admin ops endpoint resolves a nicer name but does it by spawning FFmpeg, which
 * the failure-report snapshot cannot do: that snapshot runs on the FFmpeg exit
 * path, seconds before the retry ladder re-spawns, and probing the GPU that just
 * failed is exactly what it must not do. Sysfs is a couple of file reads, so it
 * is safe there.
 *
 * This matters most for the open-source case. A self-hoster's bug report is the
 * only window a maintainer has onto hardware they do not own — and a GPU
 * transcode report that names no GPU cannot be triaged. `videoEncoders` does not
 * answer it either: that reflects how FFmpeg was compiled, not what silicon is
 * present.
 *
 * NOTE: `INTEL_GPU_NAMES` duplicates the map in
 * `api/defs/admin/ops/system-metrics.ts`. Consolidating means reaching from a
 * service into an API def (backwards layering), so the map lives here and that
 * endpoint should later import it from this module rather than the reverse.
 */

/** PCI device IDs → marketing names for Intel discrete/integrated GPUs. */
const INTEL_GPU_NAMES: Record<string, string> = {
    '0x56a0': 'Arc A770',
    '0x56a1': 'Arc A750',
    '0x56a5': 'Arc A380',
    '0x56a6': 'Arc A310',
    '0x5690': 'Arc A770M',
    '0x5691': 'Arc A730M',
    '0x5692': 'Arc A550M',
};

/** PCI vendor IDs, so a non-Intel GPU is still identified by vendor at minimum. */
const PCI_VENDORS: Record<string, string> = {
    '0x8086': 'Intel',
    '0x1002': 'AMD',
    '0x10de': 'NVIDIA',
};

export interface GpuIdentity {
    /** Best available name, e.g. "Intel Arc A380" or "AMD GPU (0x164e)". */
    name: string;
    /** PCI vendor ID as sysfs reports it, e.g. "0x8086". */
    vendorId: string;
    /** PCI device ID as sysfs reports it, e.g. "0x56a5". */
    deviceId: string;
    /** DRM card node the identity was read from, e.g. "card0". */
    card: string;
}

/**
 * Every DRM GPU visible to this container, in `/sys/class/drm` order.
 *
 * Returns an array rather than a single GPU because a host can expose more than
 * one render node, and "which one did the failing transcode use" is not
 * answerable from sysfs alone — reporting all of them lets a reader match
 * against the configured device path instead of guessing.
 *
 * Never throws: sysfs is absent on macOS and in containers without `/dev/dri`,
 * and a failure report must never be lost to an environment probe.
 */
export function readGpuIdentities(): GpuIdentity[] {
    try {
        // `card0`, not `card0-DP-1` (the connector nodes) — hence the dash filter.
        const cards = fs
            .readdirSync('/sys/class/drm')
            .filter((c) => c.startsWith('card') && !c.includes('-'));

        const out: GpuIdentity[] = [];
        for (const card of cards) {
            const base = `/sys/class/drm/${card}/device`;
            const read = (f: string): string => {
                try {
                    return fs.readFileSync(`${base}/${f}`, 'utf-8').trim();
                } catch {
                    return '';
                }
            };
            const vendorId = read('vendor');
            if (!vendorId) continue;
            const deviceId = read('device');
            const vendor = PCI_VENDORS[vendorId] ?? `Unknown vendor ${vendorId}`;
            const model = vendorId === '0x8086' ? INTEL_GPU_NAMES[deviceId] : undefined;
            out.push({
                name: model ? `${vendor} ${model}` : `${vendor} GPU (${deviceId || card})`,
                vendorId,
                deviceId,
                card,
            });
        }
        return out;
    } catch {
        // No sysfs (macOS, or no /dev/dri passed through) — not an error worth
        // surfacing, just an absent field.
        return [];
    }
}

const vendorByDeviceNode = new Map<string, string>();

/**
 * PCI vendor ID of the GPU behind a DRM device node, e.g. `/dev/dri/renderD128`
 * → "0x1002". Symlinks (`/dev/dri/by-path/…-render`) are resolved first, since
 * sysfs is keyed by the node name. '' when it can't be read (macOS, no sysfs, a
 * missing node) — callers treat that as "unknown vendor", never as an error.
 *
 * Same sysfs source as {@link readGpuIdentities}, but for ONE node: VAAPI_DEVICE
 * names the node a transcode actually encodes on, which on a multi-GPU host is
 * not necessarily card0. Readable inside an unprivileged Proxmox LXC with only
 * /dev/dri passed through (verified on a Radeon 760M).
 */
export function readDeviceNodeVendorId(devicePath: string): string {
    const cached = vendorByDeviceNode.get(devicePath);
    if (cached !== undefined) return cached;
    try {
        const node = path.basename(fs.realpathSync(devicePath));
        const vendor = fs.readFileSync(`/sys/class/drm/${node}/device/vendor`, 'utf-8').trim();
        // Only a successful read is cached: hardware doesn't change under a
        // running process, but a failed read may just be a node not there YET.
        if (vendor) vendorByDeviceNode.set(devicePath, vendor);
        return vendor;
    } catch {
        return '';
    }
}

/** Test hook: forget cached vendor reads. */
export function resetDeviceNodeVendorCache(): void {
    vendorByDeviceNode.clear();
}
