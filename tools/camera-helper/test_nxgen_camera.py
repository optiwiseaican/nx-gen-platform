"""Helper unit tests (no camera needed): python3 -m unittest tools/camera-helper/test_nxgen_camera.py"""
import importlib.util
import os
import unittest

spec = importlib.util.spec_from_file_location("nxgen_camera", os.path.join(os.path.dirname(__file__), "nxgen_camera.py"))
nx = importlib.util.module_from_spec(spec)
spec.loader.exec_module(nx)

try:
    import numpy as np
except ImportError:  # the simulator runs without numpy; these tests need it
    np = None


@unittest.skipIf(np is None, "numpy not installed")
class IdsPackedFormats(unittest.TestCase):
    def test_12_bit_g24(self):
        px = np.random.default_rng(1).integers(0, 4096, size=3504 * 4, dtype=np.uint16)
        b = np.empty((px.size // 2, 3), np.uint8)
        b[:, 0], b[:, 1] = px[0::2] >> 4, px[1::2] >> 4
        b[:, 2] = (px[0::2] & 0xF) | ((px[1::2] & 0xF) << 4)
        self.assertTrue((nx.unpack_ids(np, b.reshape(-1), px.size, "g24IDS") == px).all())

    def test_10_bit_g40(self):
        px = np.random.default_rng(2).integers(0, 1024, size=3504 * 4, dtype=np.uint16)
        b = np.empty((px.size // 4, 5), np.uint8)
        for i in range(4):
            b[:, i] = px[i::4] >> 2
        b[:, 4] = sum((px[i::4] & 3) << (2 * i) for i in range(4)).astype(np.uint8)
        self.assertTrue((nx.unpack_ids(np, b.reshape(-1), px.size, "g40IDS") == px).all())


class FormatChoice(unittest.TestCase):
    def test_names(self):
        self.assertEqual(nx.bayer_format("BayerRG12g24IDS"), ("RG", 12, "g24IDS"))
        self.assertEqual(nx.bayer_format("BayerGB10"), ("GB", 10, ""))
        self.assertIsNone(nx.bayer_format("Mono8"))

    def test_u3_34l0xcp_picks_12_bit(self):
        offered = {"BayerRG10g40IDS", "BayerRG12g24IDS"}
        self.assertEqual(next(f for f in nx.BAYER_PREFERENCE if f in offered), "BayerRG12g24IDS")


if __name__ == "__main__":
    unittest.main()


class SimulatorProtocol(unittest.TestCase):
    """Drives the helper in --simulate mode over stdin/stdout like the server does."""

    @classmethod
    def setUpClass(cls):
        import json
        import subprocess
        import sys

        cls.json = json
        cls.proc = subprocess.Popen([sys.executable, "-u", os.path.join(os.path.dirname(__file__), "nxgen_camera.py"), "--simulate"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        cls.events = []
        cls.next_id = 1
        ready = cls.json.loads(cls.proc.stdout.readline())
        assert ready["event"] == "ready" and ready["protocol"] == 2, ready

    @classmethod
    def tearDownClass(cls):
        cls.proc.stdin.write('{"id": 0, "cmd": "quit"}\n')
        cls.proc.stdin.flush()
        cls.proc.wait(timeout=10)

    @classmethod
    def call(cls, **req):
        rid = cls.next_id
        cls.next_id += 1
        cls.proc.stdin.write(cls.json.dumps({"id": rid, **req}) + "\n")
        cls.proc.stdin.flush()
        while True:
            msg = cls.json.loads(cls.proc.stdout.readline())
            if msg.get("id") == rid:
                assert msg["ok"], msg
                return msg
            cls.events.append(msg)

    def test_live_settings_change_without_restart(self):
        started = self.call(cmd="preview_start", serial="SIM-0001", exposureUs=20000, gain=1, whiteBalance=[1, 1, 1], fps=10)
        self.assertTrue(started["running"])
        changed = self.call(cmd="preview_set", serial="SIM-0001", exposureUs=60000, gain=2.5)
        self.assertEqual(changed["settings"]["exposureUs"], 60000)
        self.assertEqual(changed["settings"]["gain"], 2.5)
        self.assertEqual(changed["settings"]["wb"], [1, 1, 1])  # unchanged settings are kept
        # Frames keep coming from the same preview (seq keeps counting, no "lost").
        seqs = []
        while len(seqs) < 3:
            msg = self.json.loads(self.proc.stdout.readline())
            if msg.get("event") == "preview":
                seqs.append(msg["seq"])
            self.assertNotEqual(msg.get("event"), "lost", msg)
        self.assertEqual(seqs, sorted(seqs))
        self.call(cmd="preview_stop", serial="SIM-0001")

    def test_preview_set_needs_a_running_preview(self):
        rid = self.next_id
        self.next_id += 1
        self.proc.stdin.write(self.json.dumps({"id": rid, "cmd": "preview_set", "serial": "SIM-0001", "gain": 2}) + "\n")
        self.proc.stdin.flush()
        while True:
            msg = self.json.loads(self.proc.stdout.readline())
            if msg.get("id") == rid:
                break
        self.assertFalse(msg["ok"])
        self.assertIn("No live preview", msg["error"])

    def test_auto_exposure_and_white_balance_on_the_host(self):
        dark = self.call(cmd="auto", serial="SIM-0001", features=["exposure"], exposureUs=1000, gain=1, whiteBalance=[1, 1, 1], target=0.45)
        self.assertEqual(dark["by"], "host")
        self.assertGreater(dark["exposureUs"], 1000)
        # As bright as the sensor allows without clipping, aiming at a 45 % mean.
        self.assertLessEqual(dark["stats"]["saturated"], 0.02)
        self.assertGreater(dark["stats"]["luma"], 0.15)
        self.assertLess(dark["stats"]["luma"], 0.57)
        again = self.call(cmd="auto", serial="SIM-0001", features=["exposure"], exposureUs=dark["exposureUs"], gain=1, whiteBalance=[1, 1, 1])
        self.assertAlmostEqual(again["exposureUs"], dark["exposureUs"], delta=dark["exposureUs"] * 0.35)  # stable: a second run stays close
        bright = self.call(cmd="auto", serial="SIM-0001", features=["exposure"], exposureUs=1_500_000, gain=4, whiteBalance=[1, 1, 1])
        self.assertLess(bright["exposureUs"], 1_500_000)
        wb = self.call(cmd="auto", serial="SIM-0001", features=["whiteBalance"], exposureUs=dark["exposureUs"], gain=1, whiteBalance=[1, 1, 1])
        self.assertEqual(wb["whiteBalance"][1], 1.0)
        self.assertTrue(all(0.1 <= x <= 8 for x in wb["whiteBalance"]))

    def test_apply_and_capabilities(self):
        info = self.call(cmd="info", serial="SIM-0001")
        self.assertEqual(info["capabilities"]["autoOnHost"], ["exposure", "gain", "whiteBalance"])
        self.assertIn("digitalGain", info["capabilities"]["parameters"])
        out = self.call(cmd="apply", serial="SIM-0001", parameters={"digitalGain": 1.5, "blackLevelAuto": "Continuous", "nonsense": 1})
        self.assertEqual(out["applied"], {"digitalGain": 1.5, "blackLevelAuto": "Continuous"})
        self.assertEqual(out["unsupported"], ["nonsense"])
