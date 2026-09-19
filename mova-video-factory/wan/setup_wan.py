#!/usr/bin/env python3
"""Install an open-source Wan2.2 Animate checkout and optional model weights."""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

try:
    from .config import wan_paths
except ImportError:  # pragma: no cover - direct script execution
    from config import wan_paths

DEFAULT_REPO_URL = "https://github.com/Wan-Video/Wan2.2.git"
DEFAULT_MODEL_ID = "Wan-AI/Wan2.2-Animate-14B"


def run(command: list[str]) -> None:
    print("+", " ".join(command))
    subprocess.run(command, check=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Set up a configurable open-source Wan2.2 Animate runtime.")
    parser.add_argument("--repo-url", default=os.getenv("WAN_REPO_URL", DEFAULT_REPO_URL))
    parser.add_argument("--repo-dir", default=str(wan_paths()["repo"]))
    parser.add_argument("--weights-dir", default=str(wan_paths()["weights"]))
    parser.add_argument("--model-id", default=os.getenv("WAN_MODEL_ID", DEFAULT_MODEL_ID))
    parser.add_argument("--clone", action="store_true", help="Clone when the configured repo directory is absent.")
    parser.add_argument("--install", action="store_true", help="Install requirements.txt from the checkout.")
    parser.add_argument("--download-weights", action="store_true", help="Download weights using the logged-in Hugging Face token.")
    args = parser.parse_args()

    repo, weights = Path(args.repo_dir).expanduser(), Path(args.weights_dir).expanduser()
    if args.clone and not repo.exists():
        repo.parent.mkdir(parents=True, exist_ok=True)
        run(["git", "clone", "--depth", "1", args.repo_url, str(repo)])
    if not repo.exists():
        raise SystemExit(f"Wan checkout missing: {repo}. Re-run with --clone or set WAN_REPO_DIR.")
    if args.install:
        requirements = repo / "requirements_animate.txt"
        if not requirements.exists():
            requirements = repo / "requirements.txt"
        if not requirements.exists():
            raise SystemExit(f"No requirements.txt in {repo}; check WAN_REPO_URL/version.")
        run([sys.executable, "-m", "pip", "install", "-r", str(requirements)])
    if args.download_weights:
        weights.mkdir(parents=True, exist_ok=True)
        run([sys.executable, "-m", "huggingface_hub.commands.huggingface_cli", "download", args.model_id, "--local-dir", str(weights)])
    print("Wan setup ready.")
    print(f"repo={repo}\nweights={weights}\nmodel_id={args.model_id}")
    print("Set WAN_COMMAND_TEMPLATE if this Wan release uses different generation flags.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
