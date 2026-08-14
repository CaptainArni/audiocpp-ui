"""Convert ACE-Step's ``silence_latent.pt`` to the ``.safetensors`` its model spec wants.

The Hugging Face snapshot ships a PyTorch ``.pt``; ``model_specs/ace_step.json``
declares ``acestep-v15-<variant>/silence_latent.safetensors``. audio.cpp's own
installer converts it on download (``tools/model_manager_deprecated.py``,
``convert_ace_step_silence_latent``) — this is the same conversion, standalone,
for a model tree that was copied in by hand instead.

audio.cpp checks every file named in the spec *eagerly* when a model loads
(``add_resource_map`` in ``src/framework/model_spec/package.cpp``), so a missing
``silence_latent.safetensors`` fails the load outright rather than only when the
tensor is first read.

    python scripts/convert_ace_step_silence_latent.py <model-root>

Needs torch + safetensors (audio.cpp's own tooling already requires both).
"""

from __future__ import annotations

import sys
from pathlib import Path

import torch
from safetensors.torch import load_file, save_file

VARIANTS = ("acestep-v15-turbo", "acestep-v15-base")


def convert(variant_dir: Path, *, overwrite: bool = False) -> bool:
    """Convert one variant directory. Returns True if a file was written."""
    source = variant_dir / "silence_latent.pt"
    target = variant_dir / "silence_latent.safetensors"
    if not source.is_file():
        print(f"  skip {variant_dir.name}: no silence_latent.pt")
        return False
    if target.is_file() and not overwrite:
        print(f"  skip {variant_dir.name}: silence_latent.safetensors already exists")
        return False

    tensor = torch.load(source, map_location="cpu", weights_only=True)
    if not isinstance(tensor, torch.Tensor):
        raise SystemExit(f"ACE-Step silence latent must be a tensor: {source}")
    tensors = {"silence_latent": tensor.detach().cpu().contiguous()}

    save_file(
        tensors,
        str(target),
        metadata={"source_format": "pytorch", "source_file": str(source), "tensor_count": "1"},
    )

    # Read it back and compare — a silently truncated write would only surface
    # much later, as a wrong-sounding generation rather than an error.
    reloaded = load_file(str(target), device="cpu")
    if set(reloaded) != set(tensors):
        raise SystemExit(f"saved key set does not match source: {target}")
    for key, value in tensors.items():
        actual = reloaded[key]
        if actual.shape != value.shape or actual.dtype != value.dtype or not torch.equal(actual, value):
            raise SystemExit(f"saved tensor differs from source for {key}: {target}")

    print(f"  wrote {target}  {tuple(tensor.shape)} {tensor.dtype}")
    return True


def main(argv: list[str]) -> int:
    args = [a for a in argv if not a.startswith("-")]
    overwrite = "--overwrite" in argv
    if len(args) != 1:
        print(__doc__)
        return 2

    root = Path(args[0])
    if not root.is_dir():
        raise SystemExit(f"not a directory: {root}")

    print(f"ACE-Step model root: {root}")
    found = False
    for name in VARIANTS:
        variant = root / name
        if variant.is_dir():
            found = True
            convert(variant, overwrite=overwrite)
    if not found:
        raise SystemExit(f"no {' / '.join(VARIANTS)} directory under {root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
