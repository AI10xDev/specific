#!/usr/bin/env python3
"""Generate the README GIF from the repository's uploaded screenshot.

Requires Pillow (preview tooling only, not an application dependency):
    python3 -m venv /tmp/specific-preview
    /tmp/specific-preview/bin/pip install Pillow==12.3.0
    /tmp/specific-preview/bin/python docs/assets/generate-preview.py

The frames show static crops, not simulated application activity.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps


def main():
    root = Path(__file__).resolve().parents[2]
    source = root / "Screenshot From 2026-09-27 19-13-35.png"
    destination = Path(__file__).with_name("screenshot-preview.gif")
    with Image.open(source) as screenshot:
        terminal = screenshot.convert("RGB")

    width, height = terminal.size
    views = [
        ("Overview", terminal),
        ("Detail: output pane", terminal.crop((0, 0, width // 2, height // 2))),
        ("Detail: spec buffer", terminal.crop((width // 2, 0, width, height // 2))),
    ]
    preview_size = (1200, round(1200 * height / width))
    font = ImageFont.load_default(size=20)
    frames = []
    for label, view in views:
        frame = Image.new("RGB", (preview_size[0], preview_size[1] + 48), "#111318")
        draw = ImageDraw.Draw(frame)
        draw.text((18, 13), f"spec screenshot | {label}", font=font, fill="#e6edf3")
        frame.paste(ImageOps.contain(view, preview_size, Image.Resampling.LANCZOS), (0, 48))
        frames.append(frame.quantize(colors=128, dither=Image.Dither.NONE))

    frames[0].save(
        destination,
        save_all=True,
        append_images=frames[1:],
        duration=[3000, 4000, 4000],
        loop=0,
        optimize=True,
        disposal=2,
    )
    print(f"Generated {destination.relative_to(root)} ({destination.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
