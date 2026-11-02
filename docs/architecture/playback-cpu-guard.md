# Playback CPU guard implementation

Web processes publish versioned, 30-second snapshots to TASK Valkey. Only recent
segment demand (20 seconds), current user video transcodes, and live encoders count.
SIGSTOP-throttled, parked, preview, retired and finished encoders do not count.
GPU encoding is visible but never a primary trigger. Live TV encodes in the proxy
and offline rendition jobs (`cacheKey` / `outputDir`) are not counted yet.

Recent unthrottled CPU playback is the primary trigger. Secondary load shedding
requires active playback: web-pod cgroup v2 `cpu.pressure` **some avg10** is preferred,
with load/core as the fallback on hosts without readable PSI. Worker load is never
used. The UI settings default to 20% PSI or 2.0 load/core. Recovery uses an 80%
threshold, a 60-second hold, and at least two minutes before another secondary load
trip. A new CPU viewer immediately overrides that secondary minimum run window.
Expired samples and task-Valkey failures mean no pressure, including at checkpoints.

Pressure normally admits one background CPU task across all workers using a
renewable `SET NX EX` lease, released with a token comparison. This preserves a
progress floor. BullMQ delay retains the job, identity and attempts. The first
deferral timestamp is persisted in job data across retries/restarts and displayed
as the oldest deferred age in Load controls. **The explicit starvation escape is
15 minutes:** that job then runs once outside the pressure limiter, including its
checkpoints. This exception, manual jobs and ingest-critical
`file-system-scan-probe` jobs can exceed the normal one-task pressure allowance.
An already-running FFmpeg call finishes before its next checkpoint. On-demand
trickplay providers bypass the task scope and remain available to playback.

Background FFmpeg uses `ionice -t -c 3 nice -n 19`; the container checks this as its
unprivileged user. These priorities arbitrate **inside one cgroup**. They do not
reserve CPU across Kubernetes pods: cross-pod playback protection comes from
Kubernetes CPU requests for the web and worker pods. Production Helm values are
maintained separately from this application change.
