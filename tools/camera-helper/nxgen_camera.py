#!/usr/bin/env python3
"""
NxGen camera helper — drives IDS USB3 Vision cameras (IDS peak) for the NxGen server.

The NxGen server starts this program and talks to it over stdin/stdout, one JSON object per line.
The browser and the Electron window never touch the camera: they ask the server, the server asks
this helper. Keeping the camera in its own process means a driver crash cannot take the server
down; the server simply starts the helper again.

Requests (stdin):   {"id": 7, "cmd": "still", ...}
Responses (stdout): {"id": 7, "ok": true, ...}  or  {"id": 7, "ok": false, "error": "..."}
Events (stdout):    {"event": "ready" | "preview" | "lost" | "log", ...}

Commands
  hello                                   -> version, sdk, simulated
  list                                    -> cameras: [{serial, model, vendor, openable}]
  info         {serial}                   -> model, firmware, temperatureC, sensor, limits
  still        {serial, path, exposureUs, gain, whiteBalance:[r,g,b]}
               writes a lossless 16-bit RGB PNG to `path` (demosaiced from the raw Bayer frame,
               white balance applied on the host so it is exact and recorded)
               -> width, height, bitDepth, sourceBits, pixelFormat, exposureUs, gain,
                  whiteBalance, temperatureC, saturatedFraction, sha256
  preview_start {serial, maxSize, fps, exposureUs, gain, whiteBalance}
               -> then {"event":"preview", serial, seq, mime, width, height, data(base64)}
  preview_stop {serial}
  close        {serial}
  quit

Modes
  (default)            real cameras through IDS peak: needs the IDS peak SDK installed, plus
                       `pip install ids_peak ids_peak_ipl numpy` (Pillow optional, for JPEG previews)
  --simulate [--image plate.png]
                       a simulated camera that "photographs" a stored plate image, with exposure,
                       gain and white balance applied like a real 12-bit sensor. Standard library
                       only, so it runs anywhere (macOS development, tests).
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import struct
import sys
import threading
import time
import traceback
import zlib

PROTOCOL_VERSION = 1
HELPER_VERSION = "1.0.0"

_out_lock = threading.Lock()


def emit(obj: dict) -> None:
    line = json.dumps(obj, separators=(",", ":"))
    with _out_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def log(message: str) -> None:
    emit({"event": "log", "message": message})


class CameraError(Exception):
    """An error the user can act on; its message is shown as is."""


# ---------------------------------------------------------------------------
# PNG (standard library only)
# ---------------------------------------------------------------------------

def _chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


def png_encode(width: int, height: int, rows, bit_depth: int, channels: int = 3, level: int = 3) -> bytes:
    """rows: iterable of raw row bytes (big-endian samples for 16-bit), without filter bytes."""
    color_type = {1: 0, 3: 2, 4: 6}[channels]
    raw = bytearray()
    for row in rows:
        raw.append(0)
        raw += row
    header = struct.pack(">IIBBBBB", width, height, bit_depth, color_type, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", header) + _chunk(b"IDAT", zlib.compress(bytes(raw), level)) + _chunk(b"IEND", b"")


def png_decode_rgb8(data: bytes):
    """Decodes an 8-bit RGB/RGBA/grey PNG (non-interlaced). Returns (width, height, rgb bytes)."""
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise CameraError("The simulator image is not a PNG.")
    pos = 8
    width = height = bit_depth = color_type = None
    idat = bytearray()
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos:pos + 4])
        kind = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        pos += 12 + length
        if kind == b"IHDR":
            width, height, bit_depth, color_type, _, _, interlace = struct.unpack(">IIBBBBB", body)
            if bit_depth != 8 or interlace != 0 or color_type not in (0, 2, 6):
                raise CameraError("The simulator image must be an 8-bit, non-interlaced RGB, RGBA or grey PNG.")
        elif kind == b"IDAT":
            idat += body
        elif kind == b"IEND":
            break
    bpp = {0: 1, 2: 3, 6: 4}[color_type]
    stride = width * bpp
    raw = zlib.decompress(bytes(idat))
    out = bytearray(width * height * 3)
    prev = bytearray(stride)
    p = 0
    for y in range(height):
        f = raw[p]
        line = bytearray(raw[p + 1:p + 1 + stride])
        p += 1 + stride
        if f == 1:
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 0xFF
        elif f == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif f == 3:
            for i in range(stride):
                left = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xFF
        elif f == 4:
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                b = prev[i]
                c = prev[i - bpp] if i >= bpp else 0
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pred = a if pa <= pb and pa <= pc else (b if pb <= pc else c)
                line[i] = (line[i] + pred) & 0xFF
        prev = line
        o = y * width * 3
        if bpp == 3:
            out[o:o + width * 3] = line
        elif bpp == 4:
            out[o:o + width * 3] = bytes(b for i, b in enumerate(line) if i % 4 != 3)
        else:
            out[o:o + width * 3] = bytes(v for v in line for _ in range(3))
    return width, height, bytes(out)


# ---------------------------------------------------------------------------
# Simulated camera (standard library only)
# ---------------------------------------------------------------------------

class SimCamera:
    """
    Photographs a stored plate image as a 12-bit sensor would: at the reference settings
    (20 ms, gain 1, white balance 1/1/1) a full-scale source pixel reads 60 % of full scale;
    longer exposure or more gain scale the signal linearly and clip at 4095.
    """

    REF_EXPOSURE_US = 20000.0
    FULL = 4095

    def __init__(self, image_path: str):
        with open(image_path, "rb") as f:
            self.width, self.height, self.rgb = png_decode_rgb8(f.read())
        self.serial = "SIM-0001"
        self.lock = threading.Lock()
        self.preview_thread = None
        self.preview_stop = threading.Event()

    def describe(self) -> dict:
        return {"serial": self.serial, "model": "Simulated U3-34L0XCP-C", "vendor": "NxGen simulator", "openable": True}

    def info(self) -> dict:
        return {
            **self.describe(),
            "firmware": "simulated",
            "temperatureC": 38.5,
            "sensor": {"width": self.width, "height": self.height, "pixelFormat": "BayerRG12", "bits": 12, "shutter": "rolling"},
            "limits": {"exposureUs": [31.0, 2000000.0], "gain": [1.0, 16.0]},
            "simulated": True,
        }

    def _luts(self, exposure_us: float, gain: float, wb, levels: int):
        k = 0.6 * (exposure_us / self.REF_EXPOSURE_US) * gain
        return [[min(levels, int(round(v / 255.0 * levels * k * wb[c]))) for v in range(256)] for c in range(3)]

    def still(self, path: str, exposure_us: float, gain: float, wb) -> dict:
        with self.lock:
            luts = self._luts(exposure_us, gain, wb, self.FULL)
            # 12-bit sample -> 16-bit container (v << 4 | v >> 8), big-endian for PNG.
            to16 = [struct.pack(">H", (v << 4) | (v >> 8)) for v in range(self.FULL + 1)]
            tables = [[to16[luts[c][v]] for v in range(256)] for c in range(3)]
            t0, t1, t2 = tables
            saturated = 0
            sat0, sat1, sat2 = (set(v for v in range(256) if luts[c][v] >= self.FULL) for c in range(3))
            rows = []
            w3 = self.width * 3
            src = self.rgb
            for y in range(self.height):
                line = src[y * w3:(y + 1) * w3]
                rows.append(b"".join(t0[line[i]] + t1[line[i + 1]] + t2[line[i + 2]] for i in range(0, w3, 3)))
                saturated += sum(1 for i in range(0, w3, 3) if line[i] in sat0 or line[i + 1] in sat1 or line[i + 2] in sat2)
            png = png_encode(self.width, self.height, rows, 16)
            with open(path, "wb") as f:
                f.write(png)
            return {
                "width": self.width,
                "height": self.height,
                "bitDepth": 16,
                "sourceBits": 12,
                "pixelFormat": "BayerRG12",
                "exposureUs": float(exposure_us),
                "gain": float(gain),
                "whiteBalance": [float(x) for x in wb],
                "temperatureC": 38.5,
                "saturatedFraction": saturated / float(self.width * self.height),
                "sha256": hashlib.sha256(png).hexdigest(),
            }

    def preview_frame(self, max_size: int, exposure_us: float, gain: float, wb):
        step = max(1, -(-max(self.width, self.height) // max_size))
        luts = self._luts(exposure_us, gain, wb, 255)
        w = (self.width + step - 1) // step
        h = (self.height + step - 1) // step
        rows = []
        for y in range(0, self.height, step):
            o = y * self.width * 3
            row = bytearray()
            for x in range(0, self.width, step):
                i = o + x * 3
                row += bytes((luts[0][self.rgb[i]], luts[1][self.rgb[i + 1]], luts[2][self.rgb[i + 2]]))
            rows.append(bytes(row))
        return "image/png", w, h, png_encode(w, h, rows, 8, level=1)

    def close(self) -> None:
        pass


# ---------------------------------------------------------------------------
# IDS peak camera
# ---------------------------------------------------------------------------

BAYER_PREFERENCE = [f"Bayer{p}{b}" for b in (12, 10, 8) for p in ("RG", "GR", "GB", "BG")]


class IdsCamera:
    """
    One IDS USB3 Vision camera opened through the IDS peak genericAPI. The camera free-runs once
    opened; stills and preview frames are taken from that stream under one lock. Exposure, gain and
    pixel format are set on the camera; white balance is applied on the host so it is exact and
    recorded with the image.
    """

    def __init__(self, sdk, descriptor):
        self.p = sdk.peak
        self.ext = sdk.ext
        self.np = sdk.np
        self.Image = sdk.pil
        self.serial = _safe(descriptor.SerialNumber, "")
        self.model = _safe(descriptor.ModelName, "IDS camera")
        self.lock = threading.Lock()
        self.preview_thread = None
        self.preview_stop = threading.Event()
        self.applied = None
        try:
            self.device = descriptor.OpenDevice(self.p.DeviceAccessType_Control)
        except Exception as e:  # noqa: BLE001
            raise CameraError(f"Camera {self.serial} could not be opened (is another program using it?): {e}")
        self.nm = self.device.RemoteDevice().NodeMaps()[0]
        self._try(lambda: self._enum("UserSetSelector", "Default"))
        self._try(lambda: (self.nm.FindNode("UserSetLoad").Execute(), self.nm.FindNode("UserSetLoad").WaitUntilDone()))
        for node in ("ExposureAuto", "GainAuto", "BalanceWhiteAuto"):
            self._try(lambda n=node: self._enum(n, "Off"))
        self.pixel_format = self._choose_pixel_format()
        self.bits = int(self.pixel_format[-2:]) if self.pixel_format[-2:].isdigit() else 8
        self.pattern = self.pixel_format[5:7]
        self.stream = self.device.DataStreams()[0].OpenDataStream()
        self._start()

    # -- node helpers --
    def _try(self, fn):
        try:
            return fn()
        except Exception:  # noqa: BLE001
            return None

    def _enum(self, name, entry):
        self.nm.FindNode(name).SetCurrentEntry(entry)

    def _float(self, name, value):
        node = self.nm.FindNode(name)
        lo, hi = node.Minimum(), node.Maximum()
        node.SetValue(min(hi, max(lo, float(value))))
        return node.Value()

    def _value(self, name, default=None):
        try:
            return self.nm.FindNode(name).Value()
        except Exception:  # noqa: BLE001
            return default

    def _choose_pixel_format(self) -> str:
        node = self.nm.FindNode("PixelFormat")
        available = []
        for e in node.Entries():
            try:
                if e.AccessStatus() not in (self.p.NodeAccessStatus_NotAvailable, self.p.NodeAccessStatus_NotImplemented):
                    available.append(e.SymbolicValue())
            except Exception:  # noqa: BLE001
                pass
        for name in BAYER_PREFERENCE:
            if name in available:
                node.SetCurrentEntry(name)
                return name
        raise CameraError(f"Camera {self.serial} offers no raw Bayer format (found: {', '.join(available)}).")

    # -- acquisition --
    def _start(self):
        payload = self.nm.FindNode("PayloadSize").Value()
        for _ in range(max(3, self.stream.NumBuffersAnnouncedMinRequired())):
            self.stream.QueueBuffer(self.stream.AllocAndAnnounceBuffer(payload))
        self.nm.FindNode("TLParamsLocked").SetValue(1)
        self.stream.StartAcquisition()
        self.nm.FindNode("AcquisitionStart").Execute()
        self.nm.FindNode("AcquisitionStart").WaitUntilDone()

    def _stop(self):
        self._try(lambda: (self.nm.FindNode("AcquisitionStop").Execute(), self.nm.FindNode("AcquisitionStop").WaitUntilDone()))
        self._try(lambda: self.stream.KillWait())
        self._try(lambda: self.stream.StopAcquisition(self.p.AcquisitionStopMode_Default))
        self._try(lambda: self.stream.Flush(self.p.DataStreamFlushMode_DiscardAll))
        for b in self._try(lambda: list(self.stream.AnnouncedBuffers())) or []:
            self._try(lambda b=b: self.stream.RevokeBuffer(b))
        self._try(lambda: self.nm.FindNode("TLParamsLocked").SetValue(0))

    def configure(self, exposure_us: float, gain: float):
        key = (round(float(exposure_us), 1), round(float(gain), 3))
        if key == self.applied:
            return
        exposure = self._float("ExposureTime", exposure_us)
        # Long exposures need a lower frame rate; keep it just below 1 / exposure.
        self._try(lambda: self._float("AcquisitionFrameRate", min(self.nm.FindNode("AcquisitionFrameRate").Maximum(), 0.95e6 / max(exposure, 1.0))))
        self._try(lambda: self._enum("GainSelector", "AnalogAll"))
        self._try(lambda: self._float("Gain", gain))
        self.applied = key
        # Frames already in flight were exposed with the old settings: drop them.
        for _ in range(2):
            self._raw(timeout_ms=int(exposure / 1000.0) * 3 + 2000)

    def _raw(self, timeout_ms: int):
        np = self.np
        try:
            buf = self.stream.WaitForFinishedBuffer(timeout_ms)
        except Exception as e:  # noqa: BLE001
            raise CameraError(f"No image from camera {self.serial} within {timeout_ms} ms: {e}")
        try:
            img = self.ext.BufferToImage(buf)
            w, h = img.Width(), img.Height()
            data = np.array(img.get_numpy_1D(), copy=True)
        finally:
            self.stream.QueueBuffer(buf)
        if self.bits > 8:
            return data.view("<u2")[: w * h].reshape(h, w)
        return data[: w * h].reshape(h, w)

    def grab(self, exposure_us, gain):
        self.configure(exposure_us, gain)
        return self._raw(timeout_ms=int(float(exposure_us) / 1000.0) * 3 + 3000)

    # -- image processing --
    def _masks(self, h, w):
        np = self.np
        yy, xx = np.mgrid[0:h, 0:w]
        # Bayer layout from the two-letter pattern: row 0 = pattern (e.g. "RG"), row 1 = its complement.
        top = self.pattern
        bottom = {"RG": "GB", "GR": "BG", "GB": "RG", "BG": "GR"}[top]
        layout = {(0, 0): top[0], (0, 1): top[1], (1, 0): bottom[0], (1, 1): bottom[1]}
        masks = {}
        for c in "RGB":
            m = np.zeros((h, w), dtype=bool)
            for (dy, dx), col in layout.items():
                if col == c:
                    m |= (yy % 2 == dy) & (xx % 2 == dx)
            masks[c] = m
        return masks

    def _conv3(self, a, k):
        np = self.np
        p = np.pad(a, 1, mode="reflect")
        h, w = a.shape
        out = np.zeros_like(a)
        for dy in range(3):
            for dx in range(3):
                if k[dy][dx]:
                    out += k[dy][dx] * p[dy:dy + h, dx:dx + w]
        return out

    def demosaic(self, raw):
        """Bilinear demosaic of the raw Bayer frame -> float32 H x W x 3 in sensor units."""
        np = self.np
        a = raw.astype(np.float32)
        h, w = a.shape
        m = self._masks(h, w)
        k_rb = [[0.25, 0.5, 0.25], [0.5, 1.0, 0.5], [0.25, 0.5, 0.25]]
        k_g = [[0.0, 0.25, 0.0], [0.25, 1.0, 0.25], [0.0, 0.25, 0.0]]
        out = np.empty((h, w, 3), dtype=np.float32)
        out[..., 0] = self._conv3(a * m["R"], k_rb)
        out[..., 1] = self._conv3(a * m["G"], k_g)
        out[..., 2] = self._conv3(a * m["B"], k_rb)
        return out

    def still(self, path: str, exposure_us: float, gain: float, wb) -> dict:
        np = self.np
        with self.lock:
            raw = self.grab(exposure_us, gain)
            full = (1 << self.bits) - 1
            saturated = float((raw >= full).mean())
            rgb = self.demosaic(raw)
            for c in range(3):
                rgb[..., c] *= float(wb[c])
            scale = 65535.0 / full
            out = np.clip(rgb * scale + 0.5, 0, 65535).astype(">u2")
            h, w = raw.shape
            rows = (out[y].tobytes() for y in range(h))
            png = png_encode(w, h, rows, 16)
            with open(path, "wb") as f:
                f.write(png)
            return {
                "width": int(w),
                "height": int(h),
                "bitDepth": 16,
                "sourceBits": self.bits,
                "pixelFormat": self.pixel_format,
                "exposureUs": float(self._value("ExposureTime", exposure_us)),
                "gain": float(self._value("Gain", gain)),
                "whiteBalance": [float(x) for x in wb],
                "temperatureC": self._value("DeviceTemperature"),
                "saturatedFraction": saturated,
                "sha256": hashlib.sha256(png).hexdigest(),
            }

    def preview_frame(self, max_size: int, exposure_us: float, gain: float, wb):
        np = self.np
        with self.lock:
            raw = self.grab(exposure_us, gain)
        full = float((1 << self.bits) - 1)
        h, w = raw.shape
        # 2 x 2 "superpixel" colour, then subsample to fit max_size: fast and good enough to aim.
        m = self._masks(2, 2)
        cells = {c: [(dy, dx) for dy in range(2) for dx in range(2) if m[c][dy, dx]] for c in "RGB"}
        step = max(1, -(-max(h, w) // (2 * max_size)))
        planes = []
        for i, c in enumerate("RGB"):
            acc = None
            for dy, dx in cells[c]:
                s = raw[dy::2 * step, dx::2 * step].astype(np.float32)
                acc = s if acc is None else acc[: s.shape[0], : s.shape[1]] + s[: acc.shape[0], : acc.shape[1]]
            planes.append(acc / len(cells[c]) * float(wb[i]))
        hh = min(p.shape[0] for p in planes)
        ww = min(p.shape[1] for p in planes)
        rgb8 = np.clip(np.stack([p[:hh, :ww] for p in planes], axis=-1) * (255.0 / full), 0, 255).astype(np.uint8)
        if self.Image is not None:
            import io

            buf = io.BytesIO()
            self.Image.fromarray(rgb8, "RGB").save(buf, "JPEG", quality=80)
            return "image/jpeg", ww, hh, buf.getvalue()
        return "image/png", ww, hh, png_encode(ww, hh, (rgb8[y].tobytes() for y in range(hh)), 8, level=1)

    def info(self) -> dict:
        def limits(name):
            try:
                n = self.nm.FindNode(name)
                return [float(n.Minimum()), float(n.Maximum())]
            except Exception:  # noqa: BLE001
                return None

        return {
            "serial": self.serial,
            "model": self.model,
            "vendor": "IDS Imaging Development Systems",
            "openable": True,
            "firmware": self._value("DeviceFirmwareVersion"),
            "temperatureC": self._value("DeviceTemperature"),
            "sensor": {
                "width": int(self._value("WidthMax", self._value("Width", 0))),
                "height": int(self._value("HeightMax", self._value("Height", 0))),
                "pixelFormat": self.pixel_format,
                "bits": self.bits,
                "shutter": "rolling",
            },
            "limits": {"exposureUs": limits("ExposureTime"), "gain": limits("Gain")},
            "simulated": False,
        }

    def close(self) -> None:
        self._stop()
        self.stream = None
        self.device = None


def _safe(fn, default):
    try:
        return fn()
    except Exception:  # noqa: BLE001
        return default


class Sdk:
    """IDS peak and its Python helpers, loaded on first use with clear errors when missing."""

    def __init__(self):
        try:
            from ids_peak import ids_peak as peak  # type: ignore
            from ids_peak import ids_peak_ipl_extension as ext  # type: ignore
        except Exception as e:  # noqa: BLE001
            raise CameraError(
                "IDS peak is not installed for this Python. Install the IDS peak SDK, then "
                f"`pip install ids_peak ids_peak_ipl numpy` ({e})."
            )
        try:
            import numpy as np  # type: ignore
        except Exception:  # noqa: BLE001
            raise CameraError("numpy is required: pip install numpy")
        try:
            from PIL import Image  # type: ignore
        except Exception:  # noqa: BLE001
            Image = None
        self.peak, self.ext, self.np, self.pil = peak, ext, np, Image
        peak.Library.Initialize()
        self.version = str(_safe(peak.Library.Version, "unknown"))
        self.manager = peak.DeviceManager.Instance()

    def devices(self):
        self.manager.Update()
        return list(self.manager.Devices())


# ---------------------------------------------------------------------------
# Server protocol
# ---------------------------------------------------------------------------

class Helper:
    def __init__(self, simulate: bool, image: str | None):
        self.simulate = simulate
        self.image = image
        self.sdk = None
        self.cameras: dict[str, object] = {}

    # -- cameras --
    def _sdk(self):
        if self.sdk is None:
            self.sdk = Sdk()
        return self.sdk

    def list(self):
        if self.simulate:
            return [self._camera("SIM-0001").describe()]
        out = []
        for d in self._sdk().devices():
            serial = _safe(d.SerialNumber, "")
            out.append({
                "serial": serial,
                "model": _safe(d.ModelName, "IDS camera"),
                "vendor": _safe(d.VendorName, "IDS Imaging Development Systems"),
                "openable": bool(_safe(d.IsOpenable, False)) or serial in self.cameras,
            })
        return out

    def _camera(self, serial: str | None):
        if self.simulate:
            if "SIM-0001" not in self.cameras:
                self.cameras["SIM-0001"] = SimCamera(self.image)
            if serial not in (None, "", "SIM-0001"):
                raise CameraError(f"No camera with serial {serial}.")
            return self.cameras["SIM-0001"]
        if serial and serial in self.cameras:
            return self.cameras[serial]
        devices = self._sdk().devices()
        if not devices:
            raise CameraError("No IDS camera is connected. Check the USB 3 cable and that IDS peak sees the camera.")
        match = [d for d in devices if not serial or _safe(d.SerialNumber, "") == serial]
        if not match:
            raise CameraError(f"No camera with serial {serial} is connected.")
        cam = IdsCamera(self._sdk(), match[0])
        self.cameras[cam.serial] = cam
        return cam

    def _close(self, serial: str):
        cam = self.cameras.pop(serial, None)
        if cam is not None:
            self._stop_preview(cam)
            cam.close()

    # -- preview --
    def _stop_preview(self, cam):
        if cam.preview_thread is not None:
            cam.preview_stop.set()
            cam.preview_thread.join(timeout=5)
            cam.preview_thread = None

    def _preview_loop(self, cam, serial, max_size, fps, exposure_us, gain, wb):
        seq = 0
        period = 1.0 / max(0.5, min(fps, 15.0))
        while not cam.preview_stop.is_set():
            t0 = time.monotonic()
            try:
                mime, w, h, data = cam.preview_frame(max_size, exposure_us, gain, wb)
                seq += 1
                emit({"event": "preview", "serial": serial, "seq": seq, "mime": mime, "width": w, "height": h, "data": base64.b64encode(data).decode("ascii")})
            except Exception as e:  # noqa: BLE001
                emit({"event": "lost", "serial": serial, "error": str(e)})
                return
            cam.preview_stop.wait(max(0.0, period - (time.monotonic() - t0)))

    # -- dispatch --
    def handle(self, req: dict) -> dict:
        cmd = req.get("cmd")
        if cmd == "hello":
            sdk = "simulator" if self.simulate else _safe(lambda: self._sdk().version, "unavailable")
            return {"version": HELPER_VERSION, "protocol": PROTOCOL_VERSION, "simulated": self.simulate, "sdk": sdk}
        if cmd == "list":
            return {"cameras": self.list()}
        if cmd == "info":
            return self._camera(req.get("serial")).info()
        if cmd == "still":
            path = req.get("path")
            if not path:
                raise CameraError("still needs a path to write the image to.")
            cam = self._camera(req.get("serial"))
            wb = _wb(req.get("whiteBalance"))
            return {"serial": cam.serial, **cam.still(path, float(req.get("exposureUs", 20000)), float(req.get("gain", 1.0)), wb)}
        if cmd == "preview_start":
            cam = self._camera(req.get("serial"))
            self._stop_preview(cam)
            cam.preview_stop = threading.Event()
            cam.preview_thread = threading.Thread(
                target=self._preview_loop,
                args=(cam, cam.serial, int(req.get("maxSize", 960)), float(req.get("fps", 5)), float(req.get("exposureUs", 20000)), float(req.get("gain", 1.0)), _wb(req.get("whiteBalance"))),
                daemon=True,
            )
            cam.preview_thread.start()
            return {"serial": cam.serial}
        if cmd == "preview_stop":
            cam = self.cameras.get(req.get("serial") or ("SIM-0001" if self.simulate else ""))
            if cam is not None:
                self._stop_preview(cam)
            return {}
        if cmd == "close":
            self._close(req.get("serial") or "")
            return {}
        raise CameraError(f"Unknown command: {cmd}")

    def shutdown(self):
        for serial in list(self.cameras):
            try:
                self._close(serial)
            except Exception:  # noqa: BLE001
                pass
        if self.sdk is not None:
            _safe(self.sdk.peak.Library.Close, None)


def _wb(value):
    if not value:
        return [1.0, 1.0, 1.0]
    if len(value) != 3 or any(not (0.1 <= float(v) <= 8.0) for v in value):
        raise CameraError("White balance needs three factors between 0.1 and 8.")
    return [float(v) for v in value]


def main() -> int:
    parser = argparse.ArgumentParser(description="NxGen camera helper (IDS peak)")
    parser.add_argument("--simulate", action="store_true", help="use a simulated camera")
    parser.add_argument("--image", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "sim", "plate_uv254.png"), help="plate image the simulator photographs")
    args = parser.parse_args()
    helper = Helper(args.simulate, args.image)
    emit({"event": "ready", "version": HELPER_VERSION, "protocol": PROTOCOL_VERSION, "simulated": args.simulate})
    # One command at a time, in order; previews run in their own threads.
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            emit({"event": "log", "message": "Ignored a line that is not JSON."})
            continue
        rid = req.get("id")
        if req.get("cmd") == "quit":
            emit({"id": rid, "ok": True})
            break
        try:
            emit({"id": rid, "ok": True, **helper.handle(req)})
        except CameraError as e:
            emit({"id": rid, "ok": False, "error": str(e)})
        except Exception as e:  # noqa: BLE001
            emit({"id": rid, "ok": False, "error": f"{type(e).__name__}: {e}", "trace": traceback.format_exc(limit=5)})
    helper.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
