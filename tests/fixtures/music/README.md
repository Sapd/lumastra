# Music test fixtures

`sample.flac` — 10-second 440Hz sine wave, FLAC, 44.1kHz stereo. Generated with:

```bash
ffmpeg -f lavfi -i 'sine=frequency=440:duration=10:sample_rate=44100' \
       -ac 2 -c:a flac sample.flac
```

Used by `scripts/smoke-test-music-transcode.ts` and the music-transcode integration tests.
