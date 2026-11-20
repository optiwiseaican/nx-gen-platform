# NxGen camera helper

Drives the lamp box camera (IDS **U3-34L0XCP-C-HQ**, USB3 Vision) for the NxGen server.

Browsers and the Electron window cannot see industrial USB3 Vision cameras, so the camera is owned
by the server on the lab PC:

```
IDS camera ──USB 3──▶ IDS peak driver ──▶ nxgen-camera (this helper) ──stdin/stdout JSON──▶ NxGen server ──HTTP──▶ UI
```

The server (`apps/server/src/camera`) starts the helper, sends it commands and restarts it if it
stops. Modules capture through `ctx.cameras`; the UI shows the live view from
`GET /api/cameras/<serial>/preview`. See the protocol at the top of `nxgen_camera.py`.

## Modes

| Mode | How | Needs |
|---|---|---|
| Real cameras | `nxgen-camera` (or `python nxgen_camera.py`) | Windows or Linux, IDS peak SDK, `pip install -r requirements.txt` |
| Simulator | `--simulate [--image plate.png]` | Python 3 only (any OS, incl. macOS) |

The simulator "photographs" `sim/plate_uv254.png` like a 12-bit sensor: exposure, gain and white
balance scale the signal and clip at full scale, so the automatic exposure correction and the
quality gate behave as with the real camera.

## Server settings (environment, or the desktop app's `nxgen.env`)

| Variable | Meaning | Default |
|---|---|---|
| `NXGEN_CAMERA` | `ids`, `simulator` or `off` | `ids` in production, `simulator` in development; `off` on macOS desktop builds |
| `NXGEN_CAMERA_HELPER` | path to `nxgen-camera(.exe)` or `nxgen_camera.py` | the app's `resources/camera-helper/`, or this folder in development |
| `NXGEN_PYTHON` | Python used for a `.py` helper | `python3` (`python` on Windows) |

## Lab PC setup

1. Install **IDS peak** (Windows or Linux) and check the camera in IDS peak Cockpit. On Linux,
   install the udev rules shipped with IDS peak so the camera can be opened without root.
2. Connect the camera to a **USB 3** port (blue) with the supplied cable; it is powered by USB.
3. Build the one-file helper on that PC: `build.ps1` (Windows) or `build.sh` (Linux), and copy
   `dist/nxgen-camera(.exe)` and the `sim` folder into the NxGen app's `resources/camera-helper/`.
4. In NxGen, register the lamp box as a TLC instrument with the **camera's serial number** (printed
   on the camera box, e.g. 4110027723) so captures are tied to it.
5. Close IDS peak Cockpit before capturing: only one program can open the camera.

## Reference

The SDK calls follow IDS's own Python examples, https://github.com/ids-imaging/ids-peak-examples
(`python/gui_kivy_pipeline/camera.py` for acquisition, gain selectors and reconnect, `main.py` for the
AFL host auto features, `record_video` / `node_polling` for writability and auto nodes).

## Image processing

- Pixel format: the best raw Bayer format the camera offers (12 → 10 → 8 bit). IDS packed formats are
  supported: the U3-34L0XCP offers only `BayerRG12g24IDS` and `BayerRG10g40IDS`; frames are converted by
  IDS peak IPL, or unpacked by the helper (`unpack_ids`, tested in `test_nxgen_camera.py`).
- Stills: bilinear demosaic of the raw frame, white balance on the host (exact and recorded),
  scaled to 16 bits and written as a lossless PNG with its SHA-256.
- Live view: 2 × 2 colour cells, subsampled to ≤ 960 px, about 5 frames/s (JPEG with Pillow,
  else PNG).
- Exposure, gain and frame rate are set on the camera; the camera's continuous auto features stay
  off so every capture is repeatable. `auto` runs them **once** (IDS peak `ExposureAuto` /
  `GainAuto` / `BalanceWhiteAuto` = Once) where the camera offers them, else the helper does the
  same on the host from raw frame statistics (brightness target, 2 % saturation guard, grey-world
  white balance); the result is reported, not left running.
- A running live preview takes new settings in place (`preview_set`): no stream restart.
- Advanced parameters (`apply`, also accepted by `still` / `preview_*`): frame rate limit, digital
  gain, black level (auto / value), throughput limit — IDS peak nodes, reported as unsupported when
  a camera has no such node. `info` lists the camera's `capabilities`.

## Status

The protocol, simulator and image maths are tested on macOS (`apps/server/src/camera/camera.service.spec.ts`
runs the helper in simulator mode; the demosaic is checked for all four Bayer layouts). The IDS peak
calls (`IdsCamera`) follow the IDS peak genericAPI Python examples and **must be verified on the lab
PC with the camera** before validation.
