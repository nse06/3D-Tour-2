"""NAFNet ("Simple Baselines for Image Restoration", Chen et al., ECCV 2022), for inference: the
architecture of github.com/megvii-research/NAFNet (MIT License, Copyright (c) 2022 megvii-model),
written out here so its released weights load without BasicSR. Its channel attention averages over
windows of 384 pixels, as the authors evaluate their deblurring models (TLC, "NAFNetLocal"), so a large
photo is treated like the 256-pixel patches it was trained on, 1.5 times over.

The deblurring weights (GoPro, REDS) use width 64 with encoder blocks [1, 1, 1, 28], one middle block
and decoder blocks [1, 1, 1, 1]; the denoising ones (SIDD) [2, 2, 4, 8], 12 and [2, 2, 2, 2].
"""

from __future__ import annotations

import torch
import torch.nn as nn
import torch.nn.functional as F

CONFIGS = {
    "deblur": dict(width=64, enc_blk_nums=[1, 1, 1, 28], middle_blk_num=1, dec_blk_nums=[1, 1, 1, 1]),
    "denoise": dict(width=64, enc_blk_nums=[2, 2, 4, 8], middle_blk_num=12, dec_blk_nums=[2, 2, 2, 2]),
}


class LayerNorm2d(nn.Module):
    def __init__(self, channels: int, eps: float = 1e-6):
        super().__init__()
        self.weight = nn.Parameter(torch.ones(channels))
        self.bias = nn.Parameter(torch.zeros(channels))
        self.eps = eps

    def forward(self, x):
        mu = x.mean(1, keepdim=True)
        var = (x - mu).pow(2).mean(1, keepdim=True)
        y = (x - mu) / (var + self.eps).sqrt()
        return self.weight.view(1, -1, 1, 1) * y + self.bias.view(1, -1, 1, 1)


class LocalAvgPool(nn.Module):
    """The mean over a `kernel` × `kernel` window around every pixel (edges replicated), or over the
    whole image when it's no bigger than the window: NAFNet's channel attention, locally (TLC)."""

    def __init__(self, kernel: int):
        super().__init__()
        self.kernel = kernel

    def forward(self, x):
        n, c, h, w = x.shape
        if self.kernel >= h and self.kernel >= w:
            return x.mean((2, 3), keepdim=True)
        k1, k2 = min(h, self.kernel), min(w, self.kernel)
        s = F.pad(x.cumsum(-1).cumsum(-2), (1, 0, 1, 0))
        out = (s[:, :, k1:, k2:] + s[:, :, :-k1, :-k2] - s[:, :, :-k1, k2:] - s[:, :, k1:, :-k2]) / (k1 * k2)
        _h, _w = out.shape[2:]
        return F.pad(out, ((w - _w) // 2, (w - _w + 1) // 2, (h - _h) // 2, (h - _h + 1) // 2), mode="replicate")


class SimpleGate(nn.Module):
    def forward(self, x):
        a, b = x.chunk(2, dim=1)
        return a * b


class NAFBlock(nn.Module):
    def __init__(self, c: int, pool: int):
        super().__init__()
        dw = c * 2
        self.conv1 = nn.Conv2d(c, dw, 1)
        self.conv2 = nn.Conv2d(dw, dw, 3, padding=1, groups=dw)
        self.conv3 = nn.Conv2d(dw // 2, c, 1)
        self.sca = nn.Sequential(LocalAvgPool(pool), nn.Conv2d(dw // 2, dw // 2, 1))
        self.sg = SimpleGate()
        self.conv4 = nn.Conv2d(c, c * 2, 1)
        self.conv5 = nn.Conv2d(c, c, 1)
        self.norm1 = LayerNorm2d(c)
        self.norm2 = LayerNorm2d(c)
        self.beta = nn.Parameter(torch.zeros(1, c, 1, 1))
        self.gamma = nn.Parameter(torch.zeros(1, c, 1, 1))

    def forward(self, inp):
        x = self.sg(self.conv2(self.conv1(self.norm1(inp))))
        x = self.conv3(x * self.sca(x))
        y = inp + x * self.beta
        x = self.conv5(self.sg(self.conv4(self.norm2(y))))
        return y + x * self.gamma


class NAFNet(nn.Module):
    def __init__(self, width=64, enc_blk_nums=(1, 1, 1, 28), middle_blk_num=1, dec_blk_nums=(1, 1, 1, 1), img_channel=3, window: int = 384):
        super().__init__()
        self.intro = nn.Conv2d(img_channel, width, 3, padding=1)
        self.ending = nn.Conv2d(width, img_channel, 3, padding=1)
        self.encoders, self.decoders, self.ups, self.downs = nn.ModuleList(), nn.ModuleList(), nn.ModuleList(), nn.ModuleList()
        chan, level = width, 0
        for num in enc_blk_nums:
            self.encoders.append(nn.Sequential(*[NAFBlock(chan, max(1, window >> level)) for _ in range(num)]))
            self.downs.append(nn.Conv2d(chan, 2 * chan, 2, 2))
            chan, level = chan * 2, level + 1
        self.middle_blks = nn.Sequential(*[NAFBlock(chan, max(1, window >> level)) for _ in range(middle_blk_num)])
        for num in dec_blk_nums:
            self.ups.append(nn.Sequential(nn.Conv2d(chan, chan * 2, 1, bias=False), nn.PixelShuffle(2)))
            chan, level = chan // 2, level - 1
            self.decoders.append(nn.Sequential(*[NAFBlock(chan, max(1, window >> level)) for _ in range(num)]))
        self.padder_size = 2 ** len(self.encoders)

    def forward(self, inp):
        _, _, h, w = inp.shape
        ph, pw = (-h) % self.padder_size, (-w) % self.padder_size
        x0 = F.pad(inp, (0, pw, 0, ph))
        x = self.intro(x0)
        skips = []
        for encoder, down in zip(self.encoders, self.downs):
            x = encoder(x)
            skips.append(x)
            x = down(x)
        x = self.middle_blks(x)
        for decoder, up, skip in zip(self.decoders, self.ups, skips[::-1]):
            x = decoder(up(x) + skip)
        x = self.ending(x) + x0
        return x[:, :, :h, :w]


def load(path: str, kind: str = "deblur", device: str = "cuda") -> NAFNet:
    """A NAFNet with released weights (BasicSR's {"params": state dict} checkpoints)."""
    model = NAFNet(**CONFIGS[kind])
    state = torch.load(path, map_location="cpu", weights_only=True)
    state = state.get("params", state.get("state_dict", state))
    model.load_state_dict(state, strict=True)
    return model.to(device).eval()
