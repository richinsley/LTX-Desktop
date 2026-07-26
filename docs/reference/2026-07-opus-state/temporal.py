"""Measure temporal consistency of LTX clips: flicker, jitter, and grade drift.

Metrics per clip (computed on every consecutive frame pair, at reduced scale):
  MAD        mean |frame_t - frame_t-1|  -- raw temporal energy (motion + noise)
  jerk       std of d(MAD)/dt            -- discontinuity/popping: smooth motion has low jerk
  flicker    std of high-passed global luma -- frame-to-frame brightness instability
  flow_var   std of mean optical-flow magnitude over time -- motion-speed instability
  drift      total change in luma / saturation from first 10% to last 10% of clip
Also reports these per-thirds so we can see whether they worsen along the clip.
"""
import sys, cv2, numpy as np

def analyze(path, label):
    cap = cv2.VideoCapture(path)
    lum, sat, mad, flow = [], [], [], []
    prev_small = prev_gray_flow = None
    while True:
        ok, f = cap.read()
        if not ok: break
        small = cv2.resize(f, (320, 176)).astype(np.float32)
        hsv = cv2.cvtColor(small.astype(np.uint8), cv2.COLOR_BGR2HSV)
        lum.append(float(small.mean()))
        sat.append(float(hsv[..., 1].mean()))
        if prev_small is not None:
            mad.append(float(np.abs(small - prev_small).mean()))
            g0 = cv2.cvtColor(prev_small.astype(np.uint8), cv2.COLOR_BGR2GRAY)
            g1 = cv2.cvtColor(small.astype(np.uint8), cv2.COLOR_BGR2GRAY)
            fl = cv2.calcOpticalFlowFarneback(g0, g1, None, 0.5, 3, 15, 3, 5, 1.2, 0)
            flow.append(float(np.linalg.norm(fl, axis=2).mean()))
        prev_small = small
    cap.release()

    lum, sat, mad, flow = map(np.array, (lum, sat, mad, flow))
    n = len(lum)

    # flicker = high-frequency component of global luma (residual after 5-frame smoothing)
    k = np.ones(5) / 5
    lum_s = np.convolve(lum, k, mode="same")
    flicker = float(np.std((lum - lum_s)[3:-3]))

    jerk = float(np.std(np.diff(mad)))
    flow_var = float(np.std(flow))
    seg = max(1, n // 10)
    drift_lum = float(lum[-seg:].mean() - lum[:seg].mean())
    drift_sat = float(sat[-seg:].mean() - sat[:seg].mean())

    print(f"\n=== {label}  ({n} frames, {n/24:.1f}s) ===")
    print(f"  MAD mean {mad.mean():6.3f}   jerk {jerk:6.3f}   flicker {flicker:6.4f}   "
          f"flow_var {flow_var:6.3f}")
    print(f"  drift: luma {drift_lum:+6.2f}  saturation {drift_sat:+6.2f}")

    # per-third breakdown -- does it get worse later in the clip?
    print("  per-third:   MAD    jerk  flicker  flow_mean")
    for i in range(3):
        a, b = i * len(mad) // 3, (i + 1) * len(mad) // 3
        la, lb = i * n // 3, (i + 1) * n // 3
        seg_l = lum[la:lb]; seg_ls = np.convolve(seg_l, k, mode="same")
        fk = float(np.std((seg_l - seg_ls)[3:-3]))
        print(f"    {['1st','2nd','3rd'][i]}      {mad[a:b].mean():6.3f} "
              f"{np.std(np.diff(mad[a:b])):6.3f}  {fk:7.4f}  {flow[a:b].mean():8.3f}")
    return dict(label=label, n=n, mad=mad.mean(), jerk=jerk, flicker=flicker,
                flow_var=flow_var, drift_lum=drift_lum, drift_sat=drift_sat)

if __name__ == "__main__":
    rows = [analyze(p, l) for p, l in zip(sys.argv[1::2], sys.argv[2::2])]
    print("\n\n=== comparison (per-frame-normalized) ===")
    print(f"{'clip':<8} {'frames':>7} {'MAD':>7} {'jerk':>7} {'flicker':>8} {'flow_var':>9} {'dLuma':>7} {'dSat':>7}")
    for r in rows:
        print(f"{r['label']:<8} {r['n']:>7} {r['mad']:>7.3f} {r['jerk']:>7.3f} "
              f"{r['flicker']:>8.4f} {r['flow_var']:>9.3f} {r['drift_lum']:>+7.2f} {r['drift_sat']:>+7.2f}")
