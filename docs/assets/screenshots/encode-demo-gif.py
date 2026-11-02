# SPDX-License-Identifier: AGPL-3.0-only
"""Encode frames from capture-demo.mjs; requires Pillow. No image generation."""
import argparse
import json
from pathlib import Path
from PIL import Image

parser = argparse.ArgumentParser()
parser.add_argument('frames', type=Path)
parser.add_argument('output', type=Path)
parser.add_argument('--width', type=int, default=680)
parser.add_argument('--colors', type=int, default=192)
args = parser.parse_args()
records = json.loads((args.frames / 'frames.json').read_text())['frames']
# 15 fps with alternating 60/70 ms GIF ticks. Preserve the exact 27.3 s timeline.
resampled = []
source_index, source_end, tick = 0, records[0]['duration'], 0
total = sum(record['duration'] for record in records)
while tick < total:
    while tick >= source_end and source_index < len(records) - 1:
        source_index += 1
        source_end += records[source_index]['duration']
    next_tick = min(total, round((len(resampled) + 1) * 1000 / 15 / 10) * 10)
    resampled.append({**records[source_index], 'duration': next_tick - tick})
    tick = next_tick
records = resampled

def load(record):
    with Image.open(args.frames / record['file']) as image:
        return image.convert('RGB').resize((args.width, round(image.height * args.width / image.width)), Image.Resampling.LANCZOS)

# Shared palette avoids flickering colors between adjacent frames.
samples = [load(record) for record in records[::20]]
contact = Image.new('RGB', (160 * len(samples), 122))
for index, sample in enumerate(samples):
    sample.thumbnail((160, 122))
    contact.paste(sample, (160 * index, 0))
# Reserve exact accent colors so small brand/UI accents survive palette reduction.
palette = contact.quantize(colors=args.colors - 16, method=Image.Quantize.MEDIANCUT)
colors = palette.getpalette()[:(args.colors - 16) * 3]
for color in ['5025ff','702fff','8b5cf6','a78bfa','6366f1','7db5f5','ef4444','22c55e','facc15','ffffff','0b1020','151d32','202b45','acb8ce','f3f5fa','3b82f6']:
    colors.extend(bytes.fromhex(color))
colors.extend([0] * (768 - len(colors)))
palette.putpalette(colors)
frames = [load(record).quantize(palette=palette, dither=Image.Dither.NONE) for record in records]
args.output.parent.mkdir(parents=True, exist_ok=True)
frames[0].save(args.output, save_all=True, append_images=frames[1:],
    duration=[record['duration'] for record in records], loop=0, optimize=True, disposal=1)
with Image.open(args.output) as gif:
    duration = 0
    for index in range(gif.n_frames):
        gif.seek(index)
        duration += gif.info.get('duration', 0)
    print(f'{args.output}: {gif.size}, {gif.n_frames} frames, {duration/1000:.2f}s, {args.output.stat().st_size/1024/1024:.2f} MiB')
