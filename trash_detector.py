"""
Trash area detector.

Decides whether a scene (image, folder of images, or live webcam) is
FULL OF TRASH or CLEAN, using CLIP zero-shot classification -- no training
data needed. It also splits the frame into a grid and scores each cell so you
can see *where* the trash is.

If a trained head (trash_head.pt, made by the `train` mode) is present, it is
used instead of the zero-shot text prompts -- usually more accurate for your
own camera/location.

Usage:
    python trash_detector.py train Images/      # labels from clean_*/dirty_* names or clean/ trash/ subfolders
    python trash_detector.py evaluate TestImages/ --save results/   # accuracy, precision, recall, F1 on a test set
    python trash_detector.py capture rtsp://user:pass@192.168.254.130/Streaming/Channels/101 --every 300
                                                # save a site photo every 5 min (for building a dataset)
    python trash_detector.py image path/to/photo.jpg
    python trash_detector.py folder path/to/images/
    python trash_detector.py webcam            # press q to quit, s to save a snapshot
    python trash_detector.py webcam --camera 1 --threshold 0.6

Options:
    --threshold  trash score (0-1) above which the area counts as trashy (default 0.5)
    --grid       grid size for the per-region heatmap, e.g. 3 = 3x3 (default 3, 0 = off)
    --save       folder to write annotated results to (image/folder mode)
"""

import argparse
import sys
from pathlib import Path

import cv2
import numpy as np
import torch
from PIL import Image
from transformers import CLIPModel, CLIPProcessor

MODEL_NAME = "openai/clip-vit-base-patch32"

# Text prompts describing each class. Several phrasings per class make the
# prediction more robust; scores are summed per class.
TRASH_PROMPTS = [
    "a photo of an area full of trash",
    "a photo of garbage piled on the ground",
    "a photo of a littered street with rubbish",
    "a photo of an overflowing garbage dump",
    "a photo of plastic bottles and waste scattered everywhere",
]
CLEAN_PROMPTS = [
    "a photo of a clean area",
    "a photo of a clean street with no litter",
    "a photo of a tidy and well-kept place",
    "a photo of a clean floor",
    "a photo of a clean park with grass",
]

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
DEFAULT_HEAD = Path(__file__).with_name("trash_head.pt")

# Filename prefixes / folder names that count as each label
TRASH_NAMES = {"trash", "dirty", "garbage", "litter", "littered"}
CLEAN_NAMES = {"clean"}


def _as_tensor(feats):
    # transformers >= 5 returns a model output object instead of a raw tensor
    return feats if isinstance(feats, torch.Tensor) else feats.pooler_output


class TrashDetector:
    def __init__(self, threshold=0.5, device=None, head_path=None):
        self.threshold = threshold
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        print(f"Loading {MODEL_NAME} on {self.device} (first run downloads ~600MB)...")
        self.model = CLIPModel.from_pretrained(MODEL_NAME).to(self.device).eval()
        self.processor = CLIPProcessor.from_pretrained(MODEL_NAME)

        prompts = TRASH_PROMPTS + CLEAN_PROMPTS
        with torch.no_grad():
            text_inputs = self.processor(text=prompts, return_tensors="pt", padding=True).to(self.device)
            text_feats = _as_tensor(self.model.get_text_features(**text_inputs))
        self.text_feats = text_feats / text_feats.norm(dim=-1, keepdim=True)
        self.n_trash = len(TRASH_PROMPTS)

        self.head = None
        if head_path and Path(head_path).exists():
            state = torch.load(head_path, map_location=self.device)
            self.head = torch.nn.Linear(state["weight"].shape[1], 1).to(self.device)
            self.head.load_state_dict(state)
            print(f"Using trained head {head_path}")
        else:
            print("Using zero-shot text prompts (no trained head)")

    @torch.no_grad()
    def embed(self, pil_images, batch_size=16):
        """Normalized CLIP image embeddings for a list of PIL images."""
        feats = []
        for i in range(0, len(pil_images), batch_size):
            inputs = self.processor(images=pil_images[i:i + batch_size], return_tensors="pt").to(self.device)
            f = _as_tensor(self.model.get_image_features(**inputs))
            feats.append(f / f.norm(dim=-1, keepdim=True))
        return torch.cat(feats)

    @torch.no_grad()
    def trash_scores(self, pil_images):
        """Return a trash probability (0-1) for each PIL image."""
        img_feats = self.embed(pil_images)
        if self.head is not None:
            return torch.sigmoid(self.head(img_feats)).squeeze(-1).cpu().numpy()
        logits = self.model.logit_scale.exp() * img_feats @ self.text_feats.T
        probs = logits.softmax(dim=-1)
        return probs[:, : self.n_trash].sum(dim=-1).cpu().numpy()

    def analyze(self, bgr, grid=3):
        """Score the whole frame plus a grid x grid set of cells."""
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        crops = [Image.fromarray(rgb)]
        h, w = rgb.shape[:2]
        if grid > 0:
            for r in range(grid):
                for c in range(grid):
                    y0, y1 = r * h // grid, (r + 1) * h // grid
                    x0, x1 = c * w // grid, (c + 1) * w // grid
                    crops.append(Image.fromarray(rgb[y0:y1, x0:x1]))
        scores = self.trash_scores(crops)
        overall = float(scores[0])
        cells = scores[1:].reshape(grid, grid) if grid > 0 else None
        return {
            "score": overall,
            "is_trash": overall >= self.threshold,
            "cells": cells,
            "trash_cell_ratio": float((cells >= self.threshold).mean()) if cells is not None else None,
        }

    def annotate(self, bgr, result):
        """Draw the heatmap grid and verdict banner onto a copy of the frame."""
        out = bgr.copy()
        h, w = out.shape[:2]
        cells = result["cells"]
        if cells is not None:
            grid = cells.shape[0]
            overlay = out.copy()
            for r in range(grid):
                for c in range(grid):
                    y0, y1 = r * h // grid, (r + 1) * h // grid
                    x0, x1 = c * w // grid, (c + 1) * w // grid
                    s = float(cells[r, c])
                    # green (clean) -> red (trash)
                    color = (0, int(255 * (1 - s)), int(255 * s))
                    if s >= self.threshold:
                        cv2.rectangle(overlay, (x0, y0), (x1, y1), color, -1)
                    cv2.rectangle(out, (x0, y0), (x1, y1), color, 2)
                    # bottom-left so the top row isn't hidden by the banner
                    org = (x0 + 6, y1 - 8)
                    cv2.putText(out, f"{s:.2f}", org, cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 4)
                    cv2.putText(out, f"{s:.2f}", org, cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
            out = cv2.addWeighted(overlay, 0.3, out, 0.7, 0)

        label = "FULL OF TRASH" if result["is_trash"] else "CLEAN"
        color = (0, 0, 255) if result["is_trash"] else (0, 180, 0)
        text = f"{label}  ({result['score'] * 100:.0f}% trash)"
        cv2.rectangle(out, (0, 0), (w, 40), (0, 0, 0), -1)
        cv2.putText(out, text, (10, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.8, color, 2)
        return out


def print_result(name, result):
    label = "FULL OF TRASH" if result["is_trash"] else "CLEAN"
    extra = ""
    if result["trash_cell_ratio"] is not None:
        extra = f" | trashy regions: {result['trash_cell_ratio'] * 100:.0f}%"
    print(f"{name}: {label} (trash score {result['score']:.2f}){extra}")


def run_images(detector, paths, grid, save_dir, show):
    if save_dir:
        save_dir.mkdir(parents=True, exist_ok=True)
    for p in paths:
        bgr = cv2.imread(str(p))
        if bgr is None:
            print(f"{p}: could not read image, skipping")
            continue
        result = detector.analyze(bgr, grid)
        print_result(p.name, result)
        annotated = detector.annotate(bgr, result)
        if save_dir:
            cv2.imwrite(str(save_dir / f"{p.stem}_result{p.suffix}"), annotated)
        if show:
            cv2.imshow("Trash detector (any key = next)", fit_to_screen(annotated))
            if cv2.waitKey(0) & 0xFF == ord("q"):
                break
    cv2.destroyAllWindows()


def run_webcam(detector, camera, grid):
    cap = cv2.VideoCapture(camera)
    if not cap.isOpened():
        sys.exit(f"Could not open camera {camera}")
    print("Webcam running - press q to quit, s to save a snapshot.")
    snap = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        result = detector.analyze(frame, grid)
        annotated = detector.annotate(frame, result)
        cv2.imshow("Trash detector", annotated)
        key = cv2.waitKey(1) & 0xFF
        if key == ord("q"):
            break
        if key == ord("s"):
            name = f"snapshot_{snap}.jpg"
            cv2.imwrite(name, annotated)
            print_result(name, result)
            snap += 1
    cap.release()
    cv2.destroyAllWindows()


def label_for(path, root):
    """1 = trash, 0 = clean, None = unknown. Checks parent folders, then filename prefix."""
    for part in path.relative_to(root).parts[:-1]:
        if part.lower() in TRASH_NAMES:
            return 1
        if part.lower() in CLEAN_NAMES:
            return 0
    prefix = path.stem.lower().split("_")[0].split("-")[0]
    if prefix in TRASH_NAMES:
        return 1
    if prefix in CLEAN_NAMES:
        return 0
    return None


def fit_head(feats, labels, epochs=500):
    """Logistic regression on CLIP embeddings."""
    head = torch.nn.Linear(feats.shape[1], 1).to(feats.device)
    opt = torch.optim.Adam(head.parameters(), lr=1e-2, weight_decay=1e-4)
    # scale up the normalized embeddings so the linear layer learns quickly
    x, y = feats * 10, labels.float().unsqueeze(-1)
    for _ in range(epochs):
        opt.zero_grad()
        loss = torch.nn.functional.binary_cross_entropy_with_logits(head(x), y)
        loss.backward()
        opt.step()
    # fold the x10 scaling into the weights so inference uses raw embeddings
    with torch.no_grad():
        head.weight.mul_(10)
    return head


def run_train(detector, folder, head_path, val_split=0.2):
    root = Path(folder)
    paths, labels = [], []
    for p in sorted(root.rglob("*")):
        if p.suffix.lower() not in IMAGE_EXTS:
            continue
        lab = label_for(p, root)
        if lab is None:
            print(f"skipping {p.name}: can't tell label (name it clean_* / dirty_* or put in clean/ trash/)")
            continue
        paths.append(p)
        labels.append(lab)
    n_trash = sum(labels)
    print(f"Found {len(paths)} labeled images: {n_trash} trash, {len(paths) - n_trash} clean")
    if n_trash == 0 or n_trash == len(paths):
        sys.exit("Need images of BOTH classes to train.")

    print("Computing CLIP embeddings...")
    images = [Image.open(p).convert("RGB") for p in paths]
    feats = detector.embed(images)
    labels = torch.tensor(labels, device=feats.device)

    # hold out a validation set to report honest accuracy
    g = torch.Generator().manual_seed(0)
    perm = torch.randperm(len(paths), generator=g).to(feats.device)
    n_val = max(1, int(len(paths) * val_split))
    val, tr = perm[:n_val], perm[n_val:]

    head = fit_head(feats[tr], labels[tr])
    with torch.no_grad():
        trained_pred = (torch.sigmoid(head(feats[val])).squeeze(-1) >= 0.5).long()
        zs_logits = detector.model.logit_scale.exp() * feats[val] @ detector.text_feats.T
        zs_pred = (zs_logits.softmax(-1)[:, : detector.n_trash].sum(-1) >= 0.5).long()
    acc = (trained_pred == labels[val]).float().mean().item()
    zs_acc = (zs_pred == labels[val]).float().mean().item()
    print(f"Validation accuracy on {n_val} held-out images: trained {acc * 100:.1f}% | zero-shot {zs_acc * 100:.1f}%")
    for i, v in enumerate(val.tolist()):
        if trained_pred[i] != labels[v]:
            print(f"  wrong: {paths[v].name} predicted {'trash' if trained_pred[i] else 'clean'}")

    # final model uses every image
    head = fit_head(feats, labels)
    torch.save(head.state_dict(), head_path)
    print(f"Saved trained head to {head_path}")


def _metrics(labels, preds):
    tp = sum(1 for y, p in zip(labels, preds) if y == 1 and p == 1)
    tn = sum(1 for y, p in zip(labels, preds) if y == 0 and p == 0)
    fp = sum(1 for y, p in zip(labels, preds) if y == 0 and p == 1)
    fn = sum(1 for y, p in zip(labels, preds) if y == 1 and p == 0)
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    return {
        "tp": tp, "tn": tn, "fp": fp, "fn": fn,
        "accuracy": (tp + tn) / len(labels),
        "precision": precision,
        "recall": recall,
        "specificity": tn / (tn + fp) if tn + fp else 0.0,
        "f1": 2 * precision * recall / (precision + recall) if precision + recall else 0.0,
    }


def run_evaluate(detector, folder, threshold, save_dir=None):
    """
    Accuracy on a labeled test set (clean/ and trash/ subfolders, or clean_* / dirty_* names).
    Use photos that were NOT used for training, ideally from the real collection points.
    """
    import csv

    root = Path(folder)
    paths, labels = [], []
    for p in sorted(root.rglob("*")):
        if p.suffix.lower() in IMAGE_EXTS and (lab := label_for(p, root)) is not None:
            paths.append(p)
            labels.append(lab)
    if not paths:
        sys.exit(f"No labeled images in {root} (put them in clean/ and trash/ subfolders)")
    print(f"Evaluating {len(paths)} images: {sum(labels)} trash, {len(labels) - sum(labels)} clean")

    trained, zero_shot = [], []
    with torch.no_grad():
        for i in range(0, len(paths), 32):  # in chunks so big test sets fit in memory
            feats = detector.embed([Image.open(p).convert("RGB") for p in paths[i:i + 32]])
            if detector.head is not None:
                trained += torch.sigmoid(detector.head(feats)).squeeze(-1).cpu().tolist()
            logits = detector.model.logit_scale.exp() * feats @ detector.text_feats.T
            zero_shot += logits.softmax(dim=-1)[:, : detector.n_trash].sum(dim=-1).cpu().tolist()

    results = {"zero-shot": zero_shot}
    if trained:
        results = {"trained head": trained, **results}
    print(f"\nThreshold {threshold:.2f}, 'trash' is the positive class\n")
    print(f"{'model':<14}{'accuracy':>10}{'precision':>11}{'recall':>8}{'specificity':>13}{'F1':>7}")
    for name, scores in results.items():
        m = _metrics(labels, [int(s >= threshold) for s in scores])
        print(f"{name:<14}{m['accuracy']:>10.1%}{m['precision']:>11.1%}{m['recall']:>8.1%}{m['specificity']:>13.1%}{m['f1']:>7.3f}")
    main_name, main_scores = next(iter(results.items()))
    m = _metrics(labels, [int(s >= threshold) for s in main_scores])
    print(f"\nConfusion matrix ({main_name}):")
    print(f"{'':>18}{'predicted trash':>17}{'predicted clean':>17}")
    print(f"{'actual trash':>18}{m['tp']:>17}{m['fn']:>17}")
    print(f"{'actual clean':>18}{m['fp']:>17}{m['tn']:>17}")
    wrong = [(p, y, s) for p, y, s in zip(paths, labels, main_scores) if int(s >= threshold) != y]
    if wrong:
        print(f"\nMisclassified ({len(wrong)}):")
        for p, y, s in wrong:
            print(f"  {p.relative_to(root)}  actual {'trash' if y else 'clean'}, score {s:.2f}")

    if save_dir:
        save_dir.mkdir(parents=True, exist_ok=True)
        out = save_dir / "evaluation.csv"
        with out.open("w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["file", "actual", *[f"{n} score" for n in results], *[f"{n} correct" for n in results]])
            for i, (p, y) in enumerate(zip(paths, labels)):
                scores = [results[n][i] for n in results]
                w.writerow([str(p.relative_to(root)), "trash" if y else "clean", *[f"{s:.4f}" for s in scores],
                            *[int(s >= threshold) == y for s in scores]])
        print(f"\nPer-image results written to {out}")


def run_capture(source, every, out_dir, count=0):
    """Save a frame from a camera every `every` seconds, to collect photos of a real site for training/testing."""
    import os
    import time
    from datetime import datetime

    os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", "rtsp_transport;tcp")
    out_dir.mkdir(parents=True, exist_ok=True)
    src = int(source) if str(source).isdigit() else source
    saved = 0
    print(f"Saving a frame every {every:g} s to {out_dir} (Ctrl+C to stop)")
    try:
        while not count or saved < count:
            if isinstance(src, int):
                cap = cv2.VideoCapture(src)
            else:  # don't hang for minutes when the camera is unreachable
                cap = cv2.VideoCapture(src, cv2.CAP_FFMPEG, [cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 8000,
                                                             cv2.CAP_PROP_READ_TIMEOUT_MSEC, 8000])
            ok, frame = cap.read() if cap.isOpened() else (False, None)
            cap.release()
            if ok:
                name = out_dir / f"{datetime.now():%Y%m%d_%H%M%S}.jpg"
                cv2.imwrite(str(name), frame, [cv2.IMWRITE_JPEG_QUALITY, 90])
                saved += 1
                print(f"  {name.name}")
            else:
                print("  could not read a frame; retrying")
            time.sleep(every)
    except KeyboardInterrupt:
        pass
    print(f"Saved {saved} frame(s). Sort them into clean/ and trash/ folders to train or evaluate.")


def fit_to_screen(img, max_side=1000):
    h, w = img.shape[:2]
    scale = min(1.0, max_side / max(h, w))
    return cv2.resize(img, (int(w * scale), int(h * scale))) if scale < 1 else img


def main():
    ap = argparse.ArgumentParser(description="Detect whether an area is full of trash.")
    ap.add_argument("mode", choices=["train", "evaluate", "capture", "image", "folder", "webcam"])
    ap.add_argument("path", nargs="?", help="image file or folder (not needed for webcam); for capture: camera URL or number")
    ap.add_argument("--head", type=Path, default=DEFAULT_HEAD, help="trained head file to save/load")
    ap.add_argument("--zero-shot", action="store_true", help="ignore the trained head, use text prompts")
    ap.add_argument("--threshold", type=float, default=0.5)
    ap.add_argument("--grid", type=int, default=3)
    ap.add_argument("--camera", type=int, default=0)
    ap.add_argument("--save", type=Path, help="folder to save annotated results")
    ap.add_argument("--no-show", action="store_true", help="don't open a preview window")
    ap.add_argument("--every", type=float, default=60, help="capture: seconds between frames")
    ap.add_argument("--count", type=int, default=0, help="capture: stop after this many frames (0 = until Ctrl+C)")
    ap.add_argument("--out", type=Path, default=Path("Images") / "captured", help="capture: folder for the frames")
    args = ap.parse_args()

    if args.mode != "webcam" and not args.path:
        ap.error(f"{args.mode} mode needs a path")

    if args.mode == "train":
        run_train(TrashDetector(), args.path, args.head)
        return
    if args.mode == "capture":
        run_capture(args.path, args.every, args.out, args.count)
        return
    if args.mode == "evaluate":
        head = None if args.zero_shot else args.head
        run_evaluate(TrashDetector(head_path=head), args.path, args.threshold, args.save)
        return

    head = None if args.zero_shot else args.head
    detector = TrashDetector(threshold=args.threshold, head_path=head)

    if args.mode == "webcam":
        run_webcam(detector, args.camera, args.grid)
    elif args.mode == "image":
        run_images(detector, [Path(args.path)], args.grid, args.save, not args.no_show)
    else:
        folder = Path(args.path)
        paths = sorted(p for p in folder.iterdir() if p.suffix.lower() in IMAGE_EXTS)
        if not paths:
            sys.exit(f"No images found in {folder}")
        run_images(detector, paths, args.grid, args.save, not args.no_show)


if __name__ == "__main__":
    main()
