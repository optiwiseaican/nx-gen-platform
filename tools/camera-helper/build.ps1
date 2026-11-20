# Builds nxgen-camera.exe (one file) for the Windows lab PC.
# Prerequisites: IDS peak SDK installed, Python 3.10+ on PATH.
# Output: tools/camera-helper/dist/nxgen-camera.exe -> copy into the app's resources/camera-helper/.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
python -m venv .venv
.\.venv\Scripts\python -m pip install --upgrade pip
.\.venv\Scripts\python -m pip install -r requirements.txt pyinstaller
.\.venv\Scripts\pyinstaller --onefile --name nxgen-camera --add-data "sim;sim" --collect-all ids_peak --collect-all ids_peak_ipl --collect-all ids_peak_common --collect-all ids_peak_icv --collect-all ids_peak_afl nxgen_camera.py
Write-Host "Built dist\nxgen-camera.exe. Check it with:  dist\nxgen-camera.exe --simulate  then type {""id"":1,""cmd"":""list""}"
