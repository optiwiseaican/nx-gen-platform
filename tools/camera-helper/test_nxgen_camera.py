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
