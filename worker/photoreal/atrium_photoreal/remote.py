"""NVIDIA Fixer on Modal (fixer.py): the image it runs in, and how the trainer calls it from another
container. Used by modal_app.py and prototypes/photoreal/tools/eval_modal.py, whose containers all
import it: nothing heavy at the top.
"""

from __future__ import annotations

# Cosmos-Predict2 1.0.9 on PyTorch 2.6 with NVIDIA's prebuilt CUDA wheels (the versions its container
# has; the container itself needs an NGC login), the Fixer repository at a fixed commit, and its
# weights (Hugging Face nvidia/Fixer, about 5.5 GB) where Fixer's code looks for them.
COSMOS_WHEELS = "https://nvidia-cosmos.github.io/cosmos-dependencies/cu126_torch260/simple"
FIXER_COMMIT = "b39dfcaf4eeec90dc943b057ff368c16252c6c6e"
# These three wheels' metadata leaves out the "+cu126.torch260" their file names have, so pip rejects
# them when asked for that version: they are installed from their files instead.
COSMOS_RELEASE = "https://github.com/nvidia-cosmos/cosmos-dependencies/releases/download/v1.1.0"
COSMOS_FILES = [
    "apex @ " + COSMOS_RELEASE + "/apex-0.1%2Bcu126.torch260-cp310-cp310-linux_x86_64.whl",
    "flash-attn @ " + COSMOS_RELEASE + "/flash_attn-2.6.3%2Bcu126.torch260-cp310-cp310-linux_x86_64.whl",
    "natten @ " + COSMOS_RELEASE + "/natten-0.21.0%2Bcu126.torch260-cp310-cp310-linux_x86_64.whl",
]


def fixer_image(modal):
    return (
        modal.Image.from_registry("nvidia/cuda:12.6.3-cudnn-devel-ubuntu22.04", add_python="3.10")
        .apt_install("git", "ffmpeg", "libgl1", "libglib2.0-0")
        .pip_install(
            "torch==2.6.0+cu126",
            "torchvision==0.21.0+cu126",
            "transformer-engine==1.13.0+cu126.torch260",
            *COSMOS_FILES,
            extra_index_url=COSMOS_WHEELS,
        )
        .pip_install("cosmos-predict2==1.0.9", "natsort", "huggingface_hub[cli]>=0.32", "fastapi", extra_index_url=COSMOS_WHEELS)  # fastapi: modal_app.py imports it in every container
        .run_commands(
            f"git clone https://github.com/nv-tlabs/Fixer /opt/fixer && git -C /opt/fixer checkout {FIXER_COMMIT}",
            "huggingface-cli download nvidia/Fixer --local-dir /work/models",
        )
        .add_local_python_source("atrium_photoreal")
    )


class RemoteFixer:
    """A Modal Fixer class (warm() and fix(jpegs) methods, as in modal_app.py) as the trainer calls a
    fixer (enhance.Fixer): views go as JPEGs, `chunk` a call, in order."""

    name = "nvidia/Fixer"

    def __init__(self, remote, chunk: int = 32):
        self.remote, self.chunk = remote, chunk

    def prepare(self):
        self.remote.warm.spawn()  # its GPU starts and loads the model while training finishes

    def __call__(self, images):
        from .enhance import from_jpeg, to_jpeg

        chunks = [[to_jpeg(im) for im in images[k : k + self.chunk]] for k in range(0, len(images), self.chunk)]
        return [from_jpeg(data) for answer in self.remote.fix.map(chunks) for data in answer]
