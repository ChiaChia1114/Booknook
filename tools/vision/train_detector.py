"""
Trains the Athena-sky object detector (people, vehicles): a small CenterNet-style fully
convolutional network (heatmap per class + box size + sub-cell offset at stride 4) written
with numpy only (im2col convolutions, manual backpropagation, Adam), on the synthetic frames of
tools/vision/make-dataset.ts.

Usage: python train_detector.py <data-dir> <model-out.json> <parity-fixture-out.json> [epochs]

The exported JSON matches packages/shared/src/vision.ts (ConvNet / decodeDetections), and the
parity fixture holds two test inputs with the network's raw outputs so that the TypeScript
inference can be checked against this implementation.
"""
import base64
import json
import math
import sys
import time

import numpy as np

RNG = np.random.default_rng(1234)
STRIDE = 4
MEAN = np.array([0.5, 0.5, 0.5], np.float32)
STD = np.array([0.25, 0.25, 0.25], np.float32)
# inC, outC, k, stride, pad, dilation, relu
ARCH = [
    (3, 16, 3, 2, 1, 1, True),
    (16, 24, 3, 2, 1, 1, True),
    (24, 32, 3, 1, 1, 1, True),
    (32, 32, 3, 1, 2, 2, True),
    (32, 6, 1, 1, 0, 1, False),
]
NC = 2


# ----------------------------------------------------------------------------- data

def load(data_dir, name):
    meta = json.load(open(f"{data_dir}/{name}.json"))
    w, h = meta["width"], meta["height"]
    imgs = np.fromfile(f"{data_dir}/{name}.u8", dtype=np.uint8).reshape(-1, h, w, 3)
    return imgs, meta["labels"], w, h


def to_input(imgs_u8):
    x = imgs_u8.astype(np.float32) / 255.0
    return np.ascontiguousarray((x - MEAN) / STD)


def make_targets(labels, w, h, flip=None):
    gh, gw = h // STRIDE, w // STRIDE
    n = len(labels)
    hm = np.zeros((n, NC, gh, gw), np.float32)
    ign = np.zeros((n, 1, gh, gw), np.float32)
    pos = []  # (b, c, iy, ix, logw, logh, offx, offy)
    yy, xx = np.mgrid[0:gh, 0:gw].astype(np.float32)
    for b, boxes in enumerate(labels):
        for c, x0, y0, x1, y1, ignore in boxes:
            if flip is not None and flip[b]:
                x0, x1 = w - x1, w - x0
            gx0, gy0, gx1, gy1 = x0 / STRIDE, y0 / STRIDE, x1 / STRIDE, y1 / STRIDE
            if ignore:
                ign[b, 0, max(0, int(gy0) - 1):min(gh, int(math.ceil(gy1)) + 1), max(0, int(gx0) - 1):min(gw, int(math.ceil(gx1)) + 1)] = 1
                continue
            cx, cy = (gx0 + gx1) / 2, (gy0 + gy1) / 2
            ix, iy = min(gw - 1, int(cx)), min(gh - 1, int(cy))
            bw, bh = max(gx1 - gx0, 0.25), max(gy1 - gy0, 0.25)
            sigma = max(0.6, 0.15 * (bw + bh))
            g = np.exp(-((xx - ix) ** 2 + (yy - iy) ** 2) / (2 * sigma * sigma))
            hm[b, int(c)] = np.maximum(hm[b, int(c)], g)
            hm[b, int(c), iy, ix] = 1.0
            pos.append((b, int(c), iy, ix, math.log(bw), math.log(bh), cx - ix, cy - iy))
    return hm, ign, pos


# ----------------------------------------------------------------------------- layers

def im2col(x, k, s, p, d):
    """x: NHWC → columns (N·OH·OW, K·K·C) ordered (ky, kx, c)."""
    n, h, w, c = x.shape
    if k == 1 and s == 1 and p == 0:
        return x.reshape(n * h * w, c), h, w
    xp = np.pad(x, ((0, 0), (p, p), (p, p), (0, 0))) if p else x
    oh = (h + 2 * p - d * (k - 1) - 1) // s + 1
    ow = (w + 2 * p - d * (k - 1) - 1) // s + 1
    cols = np.empty((n, oh, ow, k, k, c), x.dtype)
    for ky in range(k):
        for kx in range(k):
            cols[:, :, :, ky, kx, :] = xp[:, ky * d: ky * d + s * (oh - 1) + 1: s, kx * d: kx * d + s * (ow - 1) + 1: s, :]
    return cols.reshape(n * oh * ow, k * k * c), oh, ow


def col2im(dcols, shape, k, s, p, d, oh, ow):
    n, h, w, c = shape
    if k == 1 and s == 1 and p == 0:
        return dcols.reshape(n, h, w, c)
    dx = np.zeros((n, h + 2 * p, w + 2 * p, c), dcols.dtype)
    dc = dcols.reshape(n, oh, ow, k, k, c)
    for ky in range(k):
        for kx in range(k):
            dx[:, ky * d: ky * d + s * (oh - 1) + 1: s, kx * d: kx * d + s * (ow - 1) + 1: s, :] += dc[:, :, :, ky, kx, :]
    return dx[:, p:p + h, p:p + w, :] if p else dx


class Conv:
    """Convolution on NHWC tensors; weights W[out][ky][kx][in] (exported as [out][in][ky][kx])."""

    def __init__(self, ic, oc, k, s, p, d, relu):
        self.k, self.s, self.p, self.d, self.relu = k, s, p, d, relu
        self.W = (RNG.standard_normal((oc, k, k, ic)) * math.sqrt(2.0 / (ic * k * k))).astype(np.float32)
        self.b = np.zeros(oc, np.float32)
        self.mW = np.zeros_like(self.W)
        self.vW = np.zeros_like(self.W)
        self.mb = np.zeros_like(self.b)
        self.vb = np.zeros_like(self.b)

    def forward(self, x, train=True):
        cols, oh, ow = im2col(x, self.k, self.s, self.p, self.d)
        oc = self.W.shape[0]
        out = cols @ self.W.reshape(oc, -1).T
        out += self.b
        if self.relu:
            np.maximum(out, 0, out=out)
        out = out.reshape(x.shape[0], oh, ow, oc)
        if train:
            self.cache = (cols, x.shape, oh, ow, out)
        return out

    def backward(self, dout, need_dx=True):
        cols, shape, oh, ow, out = self.cache
        if self.relu:
            dout = dout * (out > 0)
        oc = self.W.shape[0]
        dflat = dout.reshape(-1, oc)
        # (cols.T @ dflat).T: the same product, ~8× faster in OpenBLAS than dflat.T @ cols.
        self.dW = np.ascontiguousarray((cols.T @ dflat).T).reshape(self.W.shape)
        self.db = dflat.sum(0)
        self.cache = None
        if not need_dx:
            return None
        dcols = dflat @ self.W.reshape(oc, -1)
        return col2im(dcols, shape, self.k, self.s, self.p, self.d, oh, ow)

    def adam(self, lr, t, wd=1e-4, b1=0.9, b2=0.999, eps=1e-8):
        for P, G, M, V in ((self.W, self.dW + wd * self.W, self.mW, self.vW), (self.b, self.db, self.mb, self.vb)):
            M *= b1
            M += (1 - b1) * G
            V *= b2
            V += (1 - b2) * G * G
            mhat = M / (1 - b1 ** t)
            vhat = V / (1 - b2 ** t)
            P -= lr * mhat / (np.sqrt(vhat) + eps)


def build():
    net = [Conv(*a) for a in ARCH]
    net[-1].W *= 0.1
    net[-1].b[:NC] = -2.19  # prior 0.1 on the heatmaps
    net[-1].b[NC:NC + 2] = math.log(2.0)
    net[-1].b[NC + 2:] = 0.5
    return net


def forward(net, x, train=True):
    """x: NHWC input → head output in NCHW (channels: heatmaps, log w, log h, offsets)."""
    for l in net:
        x = l.forward(x, train)
    return np.ascontiguousarray(x.transpose(0, 3, 1, 2))


def backward(net, d):
    d = np.ascontiguousarray(d.transpose(0, 2, 3, 1))
    for i in range(len(net) - 1, -1, -1):
        d = net[i].backward(d, need_dx=i > 0)


# ----------------------------------------------------------------------------- loss

def loss_and_grad(out, hm, ign, pos):
    z = out[:, :NC]
    p = np.clip(1 / (1 + np.exp(-z)), 1e-4, 1 - 1e-4)
    is_pos = hm == 1.0
    npos = max(1, len(pos))
    negw = (1 - hm) ** 4 * (1 - ign)
    pos_l = -((1 - p) ** 2) * np.log(p) * is_pos
    neg_l = -negw * p ** 2 * np.log(1 - p) * (~is_pos)
    d_pos = (2 * p * (1 - p) ** 2 * np.log(p) - (1 - p) ** 3) * is_pos
    d_neg = -negw * (2 * p ** 2 * (1 - p) * np.log(1 - p) - p ** 3) * (~is_pos)
    grad = np.zeros_like(out)
    grad[:, :NC] = (d_pos + d_neg) / npos
    hm_loss = (pos_l.sum() + neg_l.sum()) / npos
    reg_loss = 0.0
    if pos:
        P = np.array(pos)
        b, c, iy, ix = P[:, 0].astype(int), P[:, 1].astype(int), P[:, 2].astype(int), P[:, 3].astype(int)
        for k, ch in enumerate(range(NC, NC + 4)):
            pred = out[b, ch, iy, ix]
            tgt = P[:, 4 + k]
            diff = pred - tgt
            reg_loss += np.abs(diff).sum() / npos
            np.add.at(grad, (b, ch, iy, ix), np.sign(diff) / npos)
    return hm_loss, reg_loss, grad


# ----------------------------------------------------------------------------- decoding / evaluation

def decode(out, w, h, thr=0.35):
    """Same algorithm as decodeDetections in packages/shared/src/vision.ts."""
    res = []
    for o in out:
        dets = []
        for c in range(NC):
            hmz = o[c]
            pr = 1 / (1 + np.exp(-hmz))
            gh, gw = hmz.shape
            pad = np.pad(hmz, 1, constant_values=-np.inf)
            neigh = np.max(np.stack([pad[1 + dy:1 + dy + gh, 1 + dx:1 + dx + gw] for dy in (-1, 0, 1) for dx in (-1, 0, 1) if dy or dx]), 0)
            ys, xs = np.where((pr >= thr) & (hmz >= neigh))
            for y, x in zip(ys, xs):
                bw = math.exp(o[NC, y, x]) * STRIDE
                bh = math.exp(o[NC + 1, y, x]) * STRIDE
                cx = (x + o[NC + 2, y, x]) * STRIDE
                cy = (y + o[NC + 3, y, x]) * STRIDE
                dets.append((c, float(pr[y, x]), cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2))
        dets.sort(key=lambda d: -d[1])
        kept = []
        for d in dets:
            if all(iou(d[2:], k[2:]) <= 0.5 for k in kept):
                kept.append(d)
        res.append(kept[:50])
    return res


def iou(a, b):
    x0, y0, x1, y1 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    inter = max(0, x1 - x0) * max(0, y1 - y0)
    u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / u if u > 0 else 0


def evaluate(net, imgs, labels, w, h, thr=0.35, bs=64):
    stats = {c: {"tp": 0, "fp": 0, "fn": 0} for c in range(NC)}
    for i in range(0, len(imgs), bs):
        out = forward(net, to_input(imgs[i:i + bs]), train=False)
        for dets, boxes in zip(decode(out, w, h, thr), labels[i:i + bs]):
            gts = [b for b in boxes if not b[5]]
            ign = [b for b in boxes if b[5]]
            used = set()
            for c, s, x0, y0, x1, y1 in dets:
                best, bj = 0, -1
                for j, g in enumerate(gts):
                    if j in used or g[0] != c:
                        continue
                    o = iou((x0, y0, x1, y1), g[1:5])
                    if o > best:
                        best, bj = o, j
                if best >= 0.5:
                    used.add(bj)
                    stats[c]["tp"] += 1
                elif any(iou((x0, y0, x1, y1), g[1:5]) >= 0.3 for g in ign + gts):
                    pass  # a hard (ignored) object or a poorly localised duplicate: not counted
                else:
                    stats[c]["fp"] += 1
            for j, g in enumerate(gts):
                if j not in used:
                    stats[int(g[0])]["fn"] += 1
    out = {}
    for c, name in enumerate(["person", "vehicle"]):
        s = stats[c]
        out[name] = {
            "precision": round(s["tp"] / max(1, s["tp"] + s["fp"]), 4),
            "recall": round(s["tp"] / max(1, s["tp"] + s["fn"]), 4),
            **s,
        }
    return out


# ----------------------------------------------------------------------------- export

def b64(a):
    return base64.b64encode(np.ascontiguousarray(a, dtype="<f4").tobytes()).decode()


def export(net, path, w, h, meta):
    spec = {
        "format": "athena-centernet-1",
        "input": {"width": w, "height": h},
        "stride": STRIDE,
        "classes": ["person", "vehicle"],
        "mean": MEAN.tolist(),
        "std": STD.tolist(),
        "layers": [
            {"inC": a[0], "outC": a[1], "k": a[2], "stride": a[3], "pad": a[4], "dilation": a[5], "relu": a[6], "w": b64(l.W.transpose(0, 3, 1, 2)), "b": b64(l.b)}
            for a, l in zip(ARCH, net)
        ],
        "meta": meta,
    }
    json.dump(spec, open(path, "w"))


def main():
    data_dir, model_out, parity_out = sys.argv[1], sys.argv[2], sys.argv[3]
    epochs = int(sys.argv[4]) if len(sys.argv) > 4 else 20
    tr_imgs, tr_labels, w, h = load(data_dir, "train")
    te_imgs, te_labels, _, _ = load(data_dir, "test")
    net = build()
    bs = 32
    steps_per_epoch = len(tr_imgs) // bs
    total = steps_per_epoch * epochs
    step = 0
    t0 = time.time()
    for ep in range(epochs):
        order = RNG.permutation(len(tr_imgs))
        acc = [0.0, 0.0]
        for it in range(steps_per_epoch):
            idx = order[it * bs:(it + 1) * bs]
            imgs = tr_imgs[idx].astype(np.float32) / 255.0
            flip = RNG.random(len(idx)) < 0.5
            imgs[flip] = imgs[flip][:, :, ::-1]
            # brightness / contrast jitter
            imgs = np.clip((imgs - 0.5) * RNG.uniform(0.8, 1.2, (len(idx), 1, 1, 1)) + 0.5 + RNG.uniform(-0.06, 0.06, (len(idx), 1, 1, 1)), 0, 1)
            x = np.ascontiguousarray(((imgs - MEAN) / STD).astype(np.float32))
            hm, ign, pos = make_targets([tr_labels[i] for i in idx], w, h, flip)
            out = forward(net, x)
            lh, lr_, grad = loss_and_grad(out, hm, ign, pos)
            backward(net, grad.astype(np.float32))
            step += 1
            warm = min(1.0, step / 150)
            lr = 3e-3 * warm * (0.03 + 0.97 * 0.5 * (1 + math.cos(math.pi * step / total)))
            for l in net:
                l.adam(lr, step)
            acc[0] += lh
            acc[1] += lr_
        msg = f"epoch {ep + 1}/{epochs} heatmap {acc[0] / steps_per_epoch:.4f} box {acc[1] / steps_per_epoch:.4f} ({time.time() - t0:.0f} s)"
        if (ep + 1) % 5 == 0 or ep + 1 == epochs:
            msg += " test " + json.dumps(evaluate(net, te_imgs, te_labels, w, h))
        print(msg, flush=True)
    ev = evaluate(net, te_imgs, te_labels, w, h)
    meta = {
        "trainImages": int(len(tr_imgs)),
        "testImages": int(len(te_imgs)),
        "epochs": epochs,
        "test": ev,
        "threshold": 0.35,
        "trainedWith": "tools/vision/train_detector.py (numpy)",
        "data": "synthetic frames of the Athena-sky simulator camera (tools/vision/make-dataset.ts)",
    }
    export(net, model_out, w, h, meta)
    # Parity fixture: two test inputs and the raw network outputs.
    sel = [i for i, l in enumerate(te_labels) if any(not b[5] for b in l)][:2]
    out = forward(net, to_input(te_imgs[sel]), train=False)
    json.dump(
        {
            "inputs": [base64.b64encode(te_imgs[i].tobytes()).decode() for i in sel],
            "outputs": [b64(o) for o in out],
            "shape": list(out.shape[1:]),
            "labels": [te_labels[i] for i in sel],
        },
        open(parity_out, "w"),
    )
    print("final", json.dumps(ev))


if __name__ == "__main__":
    main()
