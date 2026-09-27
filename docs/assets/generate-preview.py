#!/usr/bin/env python3
"""Generate the README GIF from the repository's uploaded screenshot.

Requires Pillow (preview tooling only, not an application dependency):
    python3 -m venv /tmp/specific-preview
    /tmp/specific-preview/bin/pip install Pillow==12.3.0
    /tmp/specific-preview/bin/python docs/assets/generate-preview.py

The frames show static crops, not simulated application activity.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def main():
    root = Path(__file__).resolve().parents[2]
    source = root / "Screenshot From 2026-07-08 13-03-13.png"
    destination = Path(__file__).with_name("screenshot-preview.gif")
    with Image.open(source) as screenshot:
        # Exclude desktop chrome and unrelated terminal tabs from the preview.
        terminal = screenshot.convert("RGB").crop((75, 126, 1912, 1060))

    views = [
        ("Overview", terminal),
        ("Detail: response", terminal.crop((0, 0, 1280, 650))),
        ("Detail: workflow and prompt", terminal.crop((0, 284, 1280, 934))),
    ]
    font = ImageFont.load_default(size=20)
    frames = []
    for label, view in views:
        frame = Image.new("RGB", (1200, 658), "#111318")
        draw = ImageDraw.Draw(frame)
        draw.text((18, 13), f"OpenCode screenshot | {label}", font=font, fill="#e6edf3")
        frame.paste(view.resize((1200, 610), Image.Resampling.LANCZOS), (0, 48))
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
