#!/usr/bin/env python3
"""Convenience entry point for resuming interrupted/failed Wan batches."""
from __future__ import annotations

import sys

try:
    from .generate_batch import main as generate_batch_main
except ImportError:  # pragma: no cover - direct script execution
    from generate_batch import main as generate_batch_main


if __name__ == "__main__":
    # Resume includes failed/running jobs below the retry cap.  Valid completed media
    # remains protected by generate_batch's validation-first selection.
    raise SystemExit(generate_batch_main(["--retry-failed", *sys.argv[1:]]))
