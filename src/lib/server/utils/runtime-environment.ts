// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Host runtime facts for the instance-diagnostics bundle: Node version, OS,
 * architecture, and container-vs-bare-metal.
 *
 * None of this is sensitive — a git-clone can see the same facts from `docker
 * inspect` or `uname -a` — but it is exactly what a maintainer has to ask for
 * as their first follow-up question on a bug report, so it belongs in the
 * bundle rather than in a round-trip.
 */

import { existsSync, readFileSync } from 'node:fs';
import { arch, platform } from 'node:os';

/** cgroup/namespace markers that only exist inside a container runtime. */
const CONTAINER_CGROUP_MARKERS = /docker|containerd|kubepods|lxc/;

/**
 * Best-effort container detection: the `/.dockerenv` marker file (Docker,
 * most compose/Podman setups), falling back to scanning PID 1's cgroup
 * membership for a container-runtime marker (catches Kubernetes and
 * non-Docker runtimes where `/.dockerenv` is absent). Never throws — an
 * unreadable or non-Linux host (no `/proc`) is reported as bare-metal rather
 * than failing the whole diagnostics bundle.
 */
export function isContainerized(): boolean {
    try {
        if (existsSync('/.dockerenv')) return true;
    } catch {
        // Ignore — fall through to the cgroup check.
    }
    try {
        const cgroup = readFileSync('/proc/1/cgroup', 'utf8');
        if (CONTAINER_CGROUP_MARKERS.test(cgroup)) return true;
    } catch {
        // Not Linux, or /proc is inaccessible (e.g. a restrictive sandbox).
    }
    return false;
}

export interface RuntimeEnvironment {
    nodeVersion: string;
    platform: string;
    arch: string;
    containerized: boolean;
}

/** Snapshot of the host/runtime this process is executing under. */
export function getRuntimeEnvironment(): RuntimeEnvironment {
    return {
        nodeVersion: process.version,
        platform: platform(),
        arch: arch(),
        containerized: isContainerized(),
    };
}
