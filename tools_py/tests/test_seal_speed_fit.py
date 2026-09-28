"""The SEAL speed fit (web sprint 2, Task W2.2c) over synthetic rows.

The model the rows come from is the spec's section 7 law: a stick hold ramps the speed linearly from 0 to the
band in 0.2 s, holds it, and a release stops at once. Rows are sampled at 20 Hz on a guest clock (seconds).
Nothing here touches PCSX2, the network or a file outside a temporary directory.
"""
import io
import math
import os
import tempfile
import unittest
from contextlib import redirect_stdout

from tools_py.parity import seal_speed_fit as F


def simulate(segments, t_end, rate=20.0, t0=0.0, start=(100.0, 50.0, 200.0), root_y=11.484, move_scale=1.0,
             sub=40):
    """Rows (t, x, y, z, root_y, move_scale) of a body that moves per `segments`:
    [(t_start, t_stop, heading_deg, band, ramp_s, wall_after_s)], heading in atan2(dz, dx) terms; the speed ramps
    linearly to `band` over `ramp_s` from t_start and is 0 outside [t_start, t_stop) or after `wall_after_s`
    (None = no wall) into the hold. Integrated on `sub` sub-steps per sample."""
    x, y, z = start
    rows = []
    dt = 1.0 / rate
    t = t0

    def vel(tt):
        for (a, b, h, band, ramp, wall) in segments:
            if a <= tt < b:
                if wall is not None and tt - a >= wall:
                    return 0.0, 0.0
                s = band if ramp <= 0 else band * min(1.0, (tt - a) / ramp)
                return s * math.cos(math.radians(h)), s * math.sin(math.radians(h))
        return 0.0, 0.0

    while t <= t_end + 1e-9:
        rows.append((round(t, 6), x, y, z, root_y, move_scale))
        h = dt / sub
        for k in range(sub):
            vx, vz = vel(t + (k + 0.5) * h)
            x += vx * h
            z += vz * h
        t += dt
    return rows


class SteadySpeedTest(unittest.TestCase):
    def test_a_forward_hold_recovers_the_band_and_the_ramp(self):
        rows = simulate([(1.0, 7.0, 30.0, 65.0, 0.2, None)], 9.0)
        fit = F.fit_holds(rows, [("fwd", 1.0, 7.0)])[0]
        self.assertEqual(fit.status, "OK")
        self.assertAlmostEqual(fit.speed, 65.0, delta=0.5)
        self.assertAlmostEqual(fit.t90, 0.18, delta=0.1)
        self.assertAlmostEqual(fit.heading_deg, 30.0, delta=1.0)
        self.assertLess(fit.resid_rms, 0.5)

    def test_the_ramp_is_recovered_off_the_sample_grid(self):
        rows = simulate([(1.013, 7.013, -60.0, 65.0, 0.2, None)], 9.0)
        fit = F.fit_holds(rows, [("fwd", 1.013, 7.013)])[0]
        self.assertAlmostEqual(fit.speed, 65.0, delta=0.5)
        self.assertAlmostEqual(fit.t90, 0.18, delta=0.1)

    def test_a_crouch_hold_at_14(self):
        rows = simulate([(1.0, 7.0, 10.0, 14.0, 0.0, None)], 9.0, root_y=5.504)
        fit = F.fit_holds(rows, [("crouch_fwd", 1.0, 7.0)])[0]
        self.assertAlmostEqual(fit.speed, 14.0, delta=0.2)
        self.assertEqual(fit.status, "OK")

    def test_the_heading(self):
        rows = simulate([(1.0, 7.0, -120.0, 65.0, 0.2, None)], 9.0)
        fit = F.fit_holds(rows, [("left", 1.0, 7.0)])[0]
        self.assertAlmostEqual(fit.heading_deg, -120.0, delta=1.0)

    def test_a_back_hold_reads_minus_37_along_the_facing(self):
        rows = simulate([(1.0, 7.0, 30.0, 65.0, 0.2, None), (10.0, 16.0, 210.0, 37.0, 0.2, None),
                         (19.0, 25.0, 120.0, 65.0, 0.2, None)], 27.0)
        fits = F.fit_holds(rows, [("fwd", 1.0, 7.0), ("back", 10.0, 16.0), ("left", 19.0, 25.0)])
        fwd, back, left = fits
        self.assertAlmostEqual(fwd.along, 65.0, delta=0.5)
        self.assertAlmostEqual(back.along, -37.0, delta=0.5)
        self.assertAlmostEqual(back.lateral, 0.0, delta=0.5)
        self.assertAlmostEqual(left.along, 0.0, delta=0.5)
        self.assertAlmostEqual(left.lateral, 65.0, delta=0.5)
        self.assertAlmostEqual(left.rel_heading_deg, 90.0, delta=1.0)

    def test_an_explicit_facing_wins(self):
        rows = simulate([(1.0, 7.0, 210.0, 37.0, 0.2, None)], 9.0)
        back = F.fit_holds(rows, [("back", 1.0, 7.0)], facing_deg=30.0)[0]
        self.assertAlmostEqual(back.along, -37.0, delta=0.5)

    def test_no_facing_hold_leaves_along_undefined(self):
        rows = simulate([(1.0, 7.0, 210.0, 37.0, 0.2, None)], 9.0)
        back = F.fit_holds(rows, [("back", 1.0, 7.0)])[0]
        self.assertTrue(math.isnan(back.along))


class RejectionTest(unittest.TestCase):
    def test_one_move_scale_row_off_1_rejects_the_hold(self):
        rows = simulate([(1.0, 7.0, 0.0, 65.0, 0.2, None)], 9.0)
        i = next(k for k, r in enumerate(rows) if r[0] >= 4.0)
        rows[i] = rows[i][:5] + (0.5,)
        fit = F.fit_holds(rows, [("fwd", 1.0, 7.0)])[0]
        self.assertFalse(fit.move_scale_ok)
        self.assertTrue(fit.status.startswith("REJECTED"), fit.status)
        self.assertIn("MoveScale", fit.status)

    def test_a_move_scale_row_outside_the_hold_does_not_reject_it(self):
        rows = simulate([(1.0, 7.0, 0.0, 65.0, 0.2, None)], 9.0)
        rows[2] = rows[2][:5] + (0.5,)
        self.assertEqual(F.fit_holds(rows, [("fwd", 1.0, 7.0)])[0].status, "OK")

    def test_a_hold_with_too_few_rows_is_rejected(self):
        rows = simulate([(1.0, 7.0, 0.0, 65.0, 0.2, None)], 9.0)
        fit = F.fit_holds(rows, [("fwd", 20.0, 21.0)])[0]
        self.assertTrue(fit.status.startswith("REJECTED"), fit.status)

    def test_a_blocked_hold_is_flagged_against_its_group(self):
        rows = simulate([(1.0, 7.0, 0.0, 65.0, 0.2, None), (10.0, 16.0, 0.0, 65.0, 0.2, 0.8),
                         (19.0, 25.0, 0.0, 65.0, 0.2, None)], 27.0)
        fits = F.fit_holds(rows, [("fwd#1", 1.0, 7.0), ("fwd#2", 10.0, 16.0), ("fwd#3", 19.0, 25.0)])
        self.assertEqual([f.group for f in fits], ["fwd", "fwd", "fwd"])
        self.assertEqual([f.blocked for f in fits], [False, True, False])
        self.assertEqual(fits[1].status, "BLOCKED")
        self.assertEqual(fits[0].status, "OK")

    def test_a_lone_hold_is_never_blocked_by_its_own_median(self):
        rows = simulate([(1.0, 7.0, 0.0, 65.0, 0.2, 0.8)], 9.0)
        self.assertFalse(F.fit_holds(rows, [("fwd", 1.0, 7.0)])[0].blocked)


class RestAndSamplingTest(unittest.TestCase):
    def test_root_y_at_rest_is_the_median_of_the_second_before(self):
        rows = simulate([(3.0, 9.0, 0.0, 65.0, 0.2, None)], 10.0, root_y=11.484)
        rows = [r if r[0] < 1.5 else r[:4] + (5.504 if r[0] < 3.0 else 11.484, 1.0) for r in rows]
        fit = F.fit_holds(rows, [("crouch_fwd", 3.0, 9.0)])[0]
        self.assertAlmostEqual(fit.root_y_rest, 5.504, places=3)

    def test_no_rows_before_the_hold_gives_nan_root(self):
        rows = simulate([(0.0, 6.0, 0.0, 65.0, 0.2, None)], 8.0)
        self.assertTrue(math.isnan(F.fit_holds(rows, [("fwd", 0.0, 6.0)])[0].root_y_rest))

    def test_repeated_guest_clock_rows_are_collapsed(self):
        rows = simulate([(1.0, 7.0, 45.0, 65.0, 0.2, None)], 9.0)
        doubled = []
        for r in rows:
            doubled += [r, r, r]
        fit = F.fit_holds(doubled, [("fwd", 1.0, 7.0)])[0]
        self.assertAlmostEqual(fit.speed, 65.0, delta=0.5)
        self.assertAlmostEqual(fit.t90, 0.18, delta=0.1)
        self.assertEqual(len(F.dedupe(doubled)), len(rows))

    def test_a_clock_that_runs_backwards_drops_the_rows(self):
        rows = [(0.0, 0, 0, 0, 1, 1), (0.1, 1, 0, 0, 1, 1), (0.05, 9, 0, 0, 1, 1), (0.2, 2, 0, 0, 1, 1)]
        self.assertEqual([r[0] for r in F.dedupe(rows)], [0.0, 0.1, 0.2])

    def test_coarse_sampling_cannot_resolve_the_ramp(self):
        rows = simulate([(1.0, 7.0, 0.0, 65.0, 0.2, None)], 9.0, rate=2.0)
        fit = F.fit_holds(rows, [("fwd", 1.0, 7.0)])[0]
        self.assertTrue(math.isnan(fit.t90))
        self.assertAlmostEqual(fit.speed, 65.0, delta=0.5)

    def test_a_noisy_steady_segment_is_flagged(self):
        rows = simulate([(1.0, 7.0, 0.0, 65.0, 0.2, None)], 9.0)
        rows = [r if not (4.0 <= r[0] <= 7.0) else (r[0], r[1] + (3.0 if int(r[0] * 20) % 2 else -3.0))
                + r[2:] for r in rows]
        fit = F.fit_holds(rows, [("fwd", 1.0, 7.0)])[0]
        self.assertEqual(fit.status, "NOISY")


class ReportAndFilesTest(unittest.TestCase):
    def test_the_report_is_a_markdown_table_with_a_row_per_hold(self):
        rows = simulate([(1.0, 7.0, 0.0, 65.0, 0.2, None), (10.0, 16.0, 180.0, 37.0, 0.2, None)], 18.0)
        rows[200] = rows[200][:5] + (0.5,)
        text = F.report(F.fit_holds(rows, [("fwd", 1.0, 7.0), ("back", 10.0, 16.0)]))
        lines = [ln for ln in text.splitlines() if ln.startswith("|")]
        self.assertEqual(len(lines), 4)
        self.assertIn("speed", lines[0])
        self.assertIn("t90", lines[0])
        self.assertTrue(set(lines[1]) <= set("|-: "))
        self.assertIn("fwd", lines[2])
        self.assertIn("REJECTED", lines[3])

    def test_rows_and_schedule_round_trip_through_files(self):
        rows = simulate([(1.0, 7.0, 0.0, 65.0, 0.2, None)], 9.0)
        d = tempfile.mkdtemp()
        rp = os.path.join(d, "rows.txt")
        with open(rp, "w") as f:
            f.write("# guest_t x y z root_y move_scale\n")
            for r in rows:
                f.write(F.format_row(r) + "\n")
        sp = os.path.join(d, "schedule.json")
        with open(sp, "w") as f:
            f.write('[{"name": "rest0", "kind": "rest", "t_start": 0.0, "t_end": 1.0},'
                    ' {"name": "fwd", "kind": "hold", "t_start": 1.0, "t_end": 7.0}]')
        back = F.load_rows(rp)
        self.assertEqual(len(back), len(rows))
        self.assertAlmostEqual(back[50][1], rows[50][1], places=4)
        holds = F.load_schedule(sp)
        self.assertEqual(holds, [F.Hold("fwd", 1.0, 7.0, "fwd")])
        buf = io.StringIO()
        with redirect_stdout(buf):
            self.assertEqual(F.main([rp, sp]), 0)
        self.assertIn("| fwd |", buf.getvalue())


if __name__ == "__main__":
    unittest.main()
