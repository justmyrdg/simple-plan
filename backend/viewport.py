"""An area's saved zoom: the part of the camera frame the detector looks at.

The view is stored as fractions of the frame (x, y = top-left corner, w, h = size, all 0-1), so it
survives a change of camera resolution. The default 0, 0, 1, 1 is the whole frame.
"""

import numpy as np

MAX_ZOOM = 8.0  # the smallest view is 1/8 of the frame in each direction
_EPS = 1e-6


def is_valid(x: float, y: float, w: float, h: float) -> bool:
    return (
        0 <= x and 0 <= y
        and w >= 1 / MAX_ZOOM - _EPS and h >= 1 / MAX_ZOOM - _EPS
        and x + w <= 1 + _EPS and y + h <= 1 + _EPS
    )


def is_full(area) -> bool:
    return area.view_x <= 0 and area.view_y <= 0 and area.view_w >= 1 and area.view_h >= 1


def crop_view(bgr: np.ndarray, area) -> np.ndarray:
    """The area's saved view cut out of a full frame (the frame itself when no zoom is saved)."""
    if is_full(area):
        return bgr
    height, width = bgr.shape[:2]
    x0 = min(width - 1, max(0, round(area.view_x * width)))
    y0 = min(height - 1, max(0, round(area.view_y * height)))
    x1 = min(width, max(x0 + 1, round((area.view_x + area.view_w) * width)))
    y1 = min(height, max(y0 + 1, round((area.view_y + area.view_h) * height)))
    return bgr[y0:y1, x0:x1]
