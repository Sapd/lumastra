#!/bin/sh
# The lean task host is the only worker runtime. Reject obsolete selectors
# before downloads, migrations, or background work can start.
case "${LUMASTRA_TASK_RUNTIME:-standalone}" in
    standalone) ;;
    *)
        echo "Unsupported LUMASTRA_TASK_RUNTIME: only standalone is supported (legacy/combined workers were removed)" >&2
        exit 64
        ;;
esac

echo "🚀 Starting Lumastra Worker..."

# This is the dedicated-worker entrypoint, so self-declare the role regardless of
# what the compose/env passes. WORKER_MODE=enabled runs the background workers;
# DEDICATED_WORKER=true labels this node 'worker' (not 'general') in the cluster
# view. The web tier uses start.sh and never starts task consumers.
export WORKER_MODE=enabled
export DEDICATED_WORKER=true
# The native watcher runs as a supervised child in this worker container.
# Exit 78 (EX_CONFIG) before side effects if the image cannot provide live updates.
watcher_binary="${LUMASTRA_WATCHER_BINARY:-build/lumastra-watcher}"
[ -x "$watcher_binary" ] || {
    echo "❌ $watcher_binary is missing or not executable."
    echo "   Rebuild the image with the watcher binary or set LUMASTRA_WATCHER_BINARY."
    exit 78
}

echo "Ensuring transcode engine..."
sh scripts/fetch-ffmpeg.sh

echo "Running database migration..."
# --import registers the .lua?raw text loader (scripts/register-lua.mjs) so tsx can
# resolve the Vite-style `import … from './*.lua?raw'` in the startup-migration
# import chain (connection.ts → services → tasks/lua/loader.ts). Without it the
# worker crash-loops with ERR_UNKNOWN_FILE_EXTENSION for aging-sweep.lua. Mirrors
# start.sh (the web entrypoint), which already wires this hook.
NODE_OPTIONS="${NODE_OPTIONS:-} --import ./scripts/register-lua.mjs" \
  node_modules/.bin/tsx --tsconfig tsconfig.scripts.json scripts/startup-migration.ts
if [ $? -ne 0 ]; then
  echo "❌ Migration failed, check logs above"
  exit 1
fi
echo "✅ Migration completed"

if [ "$LUMASTRA_LOW_RAM_MODE" = "true" ]; then
    case "$NODE_OPTIONS" in
        *--max-old-space-size*)
            echo "LUMASTRA_LOW_RAM_MODE set, but NODE_OPTIONS already has --max-old-space-size — leaving it as-is"
            ;;
        *)
            export NODE_OPTIONS="${NODE_OPTIONS} --max-old-space-size=1536"
            echo "LUMASTRA_LOW_RAM_MODE: capping V8 old-space at 1536MB"
            ;;
    esac
fi

echo "Starting BullMQ workers (WORKER_MODE=enabled)..."
exec node build/task-runtime.js
