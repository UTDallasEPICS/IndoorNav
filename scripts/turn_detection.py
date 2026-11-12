"""
turn_detection.py

Reads the path produced by navigation.py (nav_io/path.txt), detects turns by
comparing the average heading of the points BEFORE each point with the average
heading of the points AFTER it, and writes the turns to nav_io/turns.txt.

Place this file next to navigation.py.

Run:  python turn_detection.py
"""

import math
import os
import re

# ----------------------------------------------------------------------------
# ADJUSTABLE SETTINGS
# ----------------------------------------------------------------------------

# How many coordinates to average over on each side of a point.
# e.g. 5 -> compare the average angle of the last 5 coordinates with the
# average angle of the next 5 coordinates.
WINDOW_SIZE = 10

# Minimum change in average angle (degrees) that counts as a turn.
ANGLE_THRESHOLD = 45.0

# File locations. nav_io is the folder next to this script.
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
IO_DIR = os.path.join(SCRIPT_DIR, "nav_io")
PATH_FILE = os.path.join(IO_DIR, "path.txt")
TURNS_FILE = os.path.join(IO_DIR, "turns.txt")

# ----------------------------------------------------------------------------

_NUMBER = re.compile(r"-?\d+(?:\.\d+)?")


def read_path(filename):
    """Read coordinates from a file. Accepts one point per line in formats like
    '3,4', '3 4', '(3, 4)' or '[3, 4]'. Blank/non-numeric lines are skipped."""
    points = []
    with open(filename, "r") as f:
        for line in f:
            nums = _NUMBER.findall(line)
            if len(nums) >= 2:
                points.append((float(nums[0]), float(nums[1])))
    return points


def segment_angles(points):
    """Heading (radians) of each step from points[i] to points[i+1]."""
    angles = []
    for (x1, y1), (x2, y2) in zip(points, points[1:]):
        dy = y2 - y1
        angles.append(math.atan2(dy, x2 - x1))
    return angles


def average_angle(angles):
    """Circular mean, so that e.g. 359 deg and 1 deg average to 0 deg."""
    s = sum(math.sin(a) for a in angles)
    c = sum(math.cos(a) for a in angles)
    return math.atan2(s, c)


def angle_difference(a, b):
    """Signed smallest difference b - a in degrees, in (-180, 180]."""
    d = math.degrees(b - a)
    while d > 180:
        d -= 360
    while d <= -180:
        d += 360
    return d


def detect_turns(points, window=WINDOW_SIZE, threshold=ANGLE_THRESHOLD):
    """Return a list of (point_index, (x, y), signed_angle_change_degrees)."""
    angles = segment_angles(points)
    n = len(angles)

    # For point i: step headings before it are angles[i-window : i],
    # headings after it are angles[i : i+window].
    candidates = []
    for i in range(window, n - window + 1):
        before = average_angle(angles[i - window:i])
        after = average_angle(angles[i:i + window])
        change = angle_difference(before, after)
        if abs(change) >= threshold:
            candidates.append((i, change))

    # Neighbouring points around one corner all exceed the threshold; keep only
    # the point with the largest change in each consecutive group.
    turns = []
    group = []
    for item in candidates:
        if group and item[0] - group[-1][0] > 1:
            turns.append(max(group, key=lambda g: abs(g[1])))
            group = []
        group.append(item)
    if group:
        turns.append(max(group, key=lambda g: abs(g[1])))

    return [(i, points[i], change) for i, change in turns]


def write_turns(turns, filename):
    os.makedirs(os.path.dirname(filename), exist_ok=True)
    with open(filename, "w") as f:
        for idx, (x, y), change in turns:
            # Positive change = counter-clockwise as seen with the axis setting.
            direction = "LEFT" if change > 0 else "RIGHT"
            fx = int(x) if x == int(x) else x
            fy = int(y) if y == int(y) else y
            f.write(f"{fx},{fy} {direction} {abs(change):.1f}\n")


def main():
    if not os.path.exists(PATH_FILE):
        print(f"Could not find {PATH_FILE}. Run navigation.py first.")
        return

    points = read_path(PATH_FILE)
    if len(points) < 2 * WINDOW_SIZE + 1:
        print(f"Path has {len(points)} points; need at least "
              f"{2 * WINDOW_SIZE + 1} for a window size of {WINDOW_SIZE}.")
        write_turns([], TURNS_FILE)
        return

    turns = detect_turns(points)
    write_turns(turns, TURNS_FILE)
    print(f"Found {len(turns)} turn(s). Written to {TURNS_FILE}")


if __name__ == "__main__":
    main()