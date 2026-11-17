#!/usr/bin/env bash
# Builds nxgen-camera (one file) for a Linux lab PC (x86-64 or ARM64, glibc 2.34+).
# Prerequisites: IDS peak SDK installed (including its udev rules), Python 3.10+.
# Output: tools/camera-helper/dist/nxgen-camera -> copy into the app's resources/camera-helper/.
set -euo pipefail
cd "$(dirname "$0")"
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r requirements.txt pyinstaller
.venv/bin/pyinstaller --onefile --name nxgen-camera --add-data "sim:sim" --collect-all ids_peak --collect-all ids_peak_ipl nxgen_camera.py
echo "Built dist/nxgen-camera. Check it with: echo '{\"id\":1,\"cmd\":\"list\"}' | dist/nxgen-camera"
