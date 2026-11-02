// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import os from 'node:os';
import { hardwareDetection } from './hardware-detection.js';
import { readGpuIdentities } from './gpu-identity.js';
import { config } from '$lib/server/config.js';

/**
 * Environment block for a failure report.
 *
 * SYNCHRONOUS and NON-PROBING, both deliberately. This runs on the FFmpeg exit
 * path seconds before the ladder's retry — `getCapabilities()` is async AND
 * probes when its cache is cold, which would spawn ffmpeg against the very GPU
 * that just failed. So it reads only what is already cached and accepts nulls on
 * a cold cache (i.e. right after boot).
 *
 * There is no VA-API driver string cached at runtime today; capturing one is a
 * separate change to the one-time capability probe, so the field is absent rather
 * than silently null.
 */
/**
 * Read one field, degrading to `fallback` if it throws.
 *
 * The snapshot's whole job is to survive the moment a transcode fell over, and
 * its only caller wraps it in a catch that logs at DEBUG — invisible at prod log
 * level. So a single throwing field does not degrade the report, it DELETES it,
 * silently. That already happened once: a newly-read service method was absent
 * from a partial test double and took every failure record with it.
 *
 * Per-field isolation makes that structurally impossible: a field that cannot be
 * read reports `null` and the rest of the record still reaches the operator.
 */
function safely<T>(read: () => T, fallback: T | null = null): T | null {
    try {
        return read();
    } catch {
        return fallback;
    }
}

export function buildTranscodeEnvSnapshot(): Record<string, unknown> {
    const caps = safely(() => hardwareDetection.getCachedCapabilities());
    return {
        // `config.buildInfo` — NOT `npm_package_version`, which is only set when the
        // process is started BY npm. A container runs `node build/index.js`, so this
        // field read "unknown" on every production report — exactly where it matters.
        // The build identity is load-bearing for triage: a lesson or a failure has to
        // be attributable to a build before anyone can say whether a fix predates it.
        // Optional-chained on purpose. This runs on the FFmpeg exit path inside a
        // catch that logs at DEBUG, so ANY throw here silently discards the entire
        // failure record — the artifact this module exists to produce. `config` is
        // partially mocked in several suites (a Proxy over a small literal with no
        // `buildInfo`), and a bare `config.buildInfo.version` turned every one of
        // those into a lost record. Never dereference two levels of config here.
        appVersion: safely(() => config.buildInfo?.version) ?? 'unknown',
        appCommit: safely(() => config.buildInfo?.commitShort) || null,
        node: process.version,
        os: `${os.type()} ${os.release()}`,
        arch: os.arch(),
        ffmpegVersion: caps?.ffmpegVersion ?? null,
        hwaccels: caps?.hwaccels ?? null,
        // What the GPU can DECODE, not just what FFmpeg was compiled with. A report
        // about a hardware transcode that names no decode capability is not
        // actionable: the reader cannot tell a genuine silicon gap from a misrouted
        // job. (`videoEncoders` answers neither — it reflects the FFmpeg build.)
        // `?.` on `decoders` too, and an explicit `?? null` on both lists below: this
        // runs on the FFmpeg exit path inside a catch that logs at DEBUG, so anything
        // thrown here would silently discard the entire failure record — the very
        // artifact this block exists to produce — with no trace at prod log level.
        // `undefined` is also avoided deliberately: JSON.stringify DROPS undefined
        // keys, making a cold-cache report indistinguishable from a schema change.
        hardwareDecoders:
            caps?.decoders?.filter((d) => /_(cuvid|qsv|vaapi|amf|videotoolbox|v4l2m2m)$/.test(d)) ??
            null,
        // Learned decode lessons currently in force. WITHOUT THIS a bridged job reads
        // as proof the GPU cannot decode the codec, when it may just be carrying a
        // stale lesson — the exact false conclusion that hid this bug for two days.
        // An empty array means "no lesson diverted this job"; a populated one is the
        // first thing to check before blaming the hardware.
        learnedDecodeDenials: safely(() => hardwareDetection.getNonHardwareDecodableCodecs()),
        // The silicon actually present, from sysfs (spawn-free — see gpu-identity.ts).
        // For a self-hoster's bug report this is the maintainer's only window onto
        // hardware they do not own, and `videoEncoders` cannot substitute: that
        // reflects the FFmpeg build, not the GPU. `nvidiaGpuName` stays because it
        // is a richer NVIDIA-specific string from nvidia-smi when one is cached.
        gpus: safely(() => readGpuIdentities()),
        nvidiaGpuName: safely(() => hardwareDetection.getCachedNvidiaGpuName()),
        // Trimmed to the hardware encoders — the full list is ~200 entries of
        // a64multi/bmp/xbm that bury the signal in a pasted issue.
        videoEncoders:
            caps?.encoders?.filter((e) =>
                /_(nvenc|qsv|vaapi|amf|videotoolbox|v4l2m2m|vulkan)$/.test(e),
            ) ?? null,
    };
}
