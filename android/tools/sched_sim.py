"""Simulate the renderer's frame scheduling (gl/Renderer.kt onFrame) to check the power pacing.

Mirrors: ring slots, frames waiting on their detection (pending), the preview queue
(toShow), paced capture (DetectPacer + MAX_STRIDE), async detection with jitter and
the emission rules. Reports frames emitted before their detection ("forced", which
fall back to motion prediction) and preview frames dropped.

Usage: python3 tools/sched_sim.py
"""
import random
MS=1_000_000
TIERS={0:(0,0,0),1:(100,66,0),2:(150,100,33),3:(200,125,50),4:(250,150,66)}
def sim(fps, tier, det_ms, faces, slots_n=12, frames=3000, jitter=0.3, seed=1, backlog=6):
    rnd=random.Random(seed)
    frame=int(1e9/fps); idle,face,motion=[v*MS for v in TIERS[tier]]
    interval={'none':idle,'calm':face,'fast':motion}[faces]
    maxp=max(1,slots_n-3)
    slots=list(range(slots_n)); pending=[]; toShow=[]; shown=None; ts_of={}
    latest=-1; readback=None; busy_until=None; busy_ts=None; last_cap=-10**18
    forced=0; emitted=0; skipped_preview=0; drawn=[]; frameNs=frame; lastMs=det_ms
    for i in range(frames):
        now=i*frame; ts=now
        # detection completion
        if busy_until is not None and now>=busy_until:
            latest=max(latest,busy_ts); busy_until=None
        # acquire
        while True:
            free=[s for s in slots if s not in pending and s!=shown and s not in toShow]
            if free: slot=free[0]; break
            if toShow: toShow.pop(0); skipped_preview+=1; continue
            s=pending.pop(0); emitted+=1; forced+= latest<ts_of[s]; toShow.append(s)
        ts_of[slot]=ts; pending.append(slot)
        # pollReadback (captured last frame -> submitted now)
        if readback is not None:
            d=det_ms*(1+rnd.uniform(-jitter,jitter))
            busy_until=now+int(d*MS); busy_ts=readback; readback=None; lastMs=d
        # capture
        cap=min(interval, max(0,(maxp-1)*frameNs-int(lastMs*MS+frameNs/2)), 4*frameNs)  # MAX_STRIDE = 4
        if readback is None and busy_until is None and ts-last_cap >= cap-frameNs//2:
            readback=ts; last_cap=ts
        # emitReady
        while pending:
            s=pending[0]; cov=latest>=ts_of[s]
            if cov or len(pending)>maxp:
                pending.pop(0); emitted+=1; forced+= (not cov); toShow.append(s)
            else: break
        # drawPreview
        while len(toShow)>backlog: toShow.pop(0); skipped_preview+=1
        if toShow: shown=toShow.pop(0); drawn.append(ts_of[shown])
    # preview smoothness: fraction of camera frames with a new preview frame (after warmup)
    smooth=len(drawn)/frames
    delays=[]
    return forced, emitted, skipped_preview, round(smooth,3)

if __name__ == "__main__":
    bad = []
    for slots, fpss in ((12, (24, 25, 30, 50, 60)), (10, (24, 30, 60))):  # 1080p, 4K
        for fps in fpss:
            for tier in range(5):
                for det in (8, 15, 20, 30):
                    for faces in ("none", "calm", "fast"):
                        r = sim(fps, tier, det, faces, slots_n=slots)
                        if r[0] or r[2] > 5 or r[3] < 0.98:
                            bad.append((slots, fps, tier, det, faces, r))
    print("issues:", bad or "none")
    raise SystemExit(1 if bad else 0)
