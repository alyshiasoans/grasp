import os, sys, threading, time, joblib
import numpy as np
import matplotlib
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from scipy.signal import butter, lfilter, lfilter_zi, iirnotch
from scipy.io import loadmat
from collections import deque
import imageio

MAT_PATH       = "KateGesturesRound2Jan20.mat"
MODEL_PATH     = os.path.join(os.path.dirname(os.path.abspath(__file__)), "backend", "kate_model_1.pkl")
PLAYBACK_SPEED = 1.0
VIDEO_PATH     = "gesture_output.mp4"
VIDEO_FPS      = 20

GESTURE_CLASSES = {0:"Open",1:"Close",2:"Thumbs Up",3:"Peace",
                   4:"Index Point",5:"Four",6:"Okay",7:"Spiderman"}
GESTURE_COLORS  = {"Open":"#00e5ff","Close":"#ff4081","Thumbs Up":"#69ff47",
                   "Peace":"#ffd740","Index Point":"#e040fb","Four":"#ff6d00",
                   "Okay":"#00e676","Spiderman":"#ff1744"}

F_LOWER=20;F_UPPER=450;F_NOTCH=60;BW_NOTCH=2
T_ON=1.0;T_OFF=0.6
DET_WIN_MS=200;DET_STEP_MS=100
WIN_MS=200;STEP_MS=100
N_ON=1;N_OFF=1
MAX_GESTURE_S=3.5
MIN_VOTES=8   # ignore gestures with fewer votes than this

# shared state — just plain variables, updated by worker, read by GUI
state = {
    "label":   "LOADING...",
    "gesture": "—",
    "color":   "#ffffff",
    "act":     0.0,
    "log":     [],
    "dirty":   False,
    "reset_after": 0.0,
    "reset_time":  0.0,
    "sig_buf":  deque(maxlen=10000),  # rolling activation envelope
}
_lock = threading.Lock()

def update(**kwargs):
    with _lock:
        state.update(kwargs)
        state["dirty"] = True

def add_log(text):
    with _lock:
        state["log"].append(text)
        if len(state["log"]) > 12:
            state["log"].pop(0)
        state["dirty"] = True

# ── worker ─────────────────────────────────────────────────────────────────────
def worker():
    print("[worker] loading...")
    m   = loadmat(MAT_PATH)
    sig = np.array(m['Data'], dtype=float)[:, :64]
    Fs  = float(np.squeeze(m['SamplingFrequency']))
    scaler, model = joblib.load(MODEL_PATH)
    print(f"[worker] {sig.shape[0]} samples @ {Fs} Hz")

    b_bp,a_bp = butter(2,[F_LOWER/(Fs/2),F_UPPER/(Fs/2)],btype='band')
    b_n,a_n   = iirnotch(F_NOTCH/(Fs/2),F_NOTCH/BW_NOTCH)
    zi_bp = np.tile(lfilter_zi(b_bp,a_bp),(64,1))
    zi_n  = np.tile(lfilter_zi(b_n, a_n), (64,1))

    def filt(x):
        nonlocal zi_bp,zi_n
        y,zi_bp[:]=lfilter(b_bp,a_bp,x[:,None],zi=zi_bp)
        y,zi_n[:] =lfilter(b_n, a_n, y,        zi=zi_n)
        return y.squeeze()

    def feats(w,thr=0.01):
        ch,_=w.shape
        MAV=np.mean(np.abs(w),axis=1)
        WL=np.sum(np.abs(np.diff(w,axis=1)),axis=1)
        ZC=np.zeros(ch);SSC=np.zeros(ch)
        for i in range(ch):
            x=w[i];s=np.diff(x)
            ZC[i]=np.sum(((x[:-1]*x[1:])<0)&(np.abs(x[:-1]-x[1:])>=thr))
            SSC[i]=np.sum(((s[:-1]*s[1:])<0)&(np.abs(s[:-1])>=thr)&(np.abs(s[1:])>=thr))
        return np.concatenate([MAV,WL,ZC,SSC])

    det_win=int(DET_WIN_MS/1000*Fs);det_step=int(DET_STEP_MS/1000*Fs)
    win_s=int(WIN_MS/1000*Fs);step_s=int(STEP_MS/1000*Fs)
    max_g=int(MAX_GESTURE_S*Fs)
    rest_mean=np.sqrt(np.mean(sig[:int(Fs*2),:]**2,axis=0))
    det_buf=deque(maxlen=det_win);gest_buf=[]
    det_ctr=0;state_=0;cnt_on=0;cnt_off=0
    dt=1.0/(Fs*PLAYBACK_SPEED);log_ctr=0
    votes=[]          # accumulate votes across whole gesture
    last_printed=""   # track last displayed gesture to avoid spamming log

    update(label="REST", gesture="REST", color="#444444", act=0.0)

    t_start = time.perf_counter()          # absolute start time
    for i, raw in enumerate(sig):
        filtered=filt(raw-np.mean(raw))
        if state_==1: gest_buf.append(filtered)
        det_buf.append(filtered)
        if len(det_buf)<det_win:
            target = t_start + (i + 1) * dt
            rem = target - time.perf_counter()
            if rem > 0: time.sleep(rem)
            continue
        det_ctr+=1
        if det_ctr<det_step:
            target = t_start + (i + 1) * dt
            rem = target - time.perf_counter()
            if rem > 0: time.sleep(rem)
            continue
        det_ctr=0

        w=np.stack(det_buf,axis=1)
        act=float(np.median(np.sqrt(np.mean(w**2,axis=1))/(rest_mean+1e-8)))

        log_ctr+=1
        if log_ctr%5==0: #log_ctr%10==0:
            with _lock:
                state["sig_buf"].append(act)
            update(act=act, label="ACTIVE" if state_ else "REST", #)
                gesture="" if state_ else "REST", #added
                color="#ffffff" if state_ else "#444444") #added

        if state_==0:
            if act>T_ON:
                cnt_on+=1
                if cnt_on>=N_ON:
                    update(label="ACTIVE", gesture="", color="#ffffff")
                    add_log("▶  gesture start")
                    state_=1; gest_buf=[]; votes=[]; last_printed=""; cnt_on=0
            else: cnt_on=0
        else:
            gest_buf.append(filtered)
            cnt_off=cnt_off+1 if act<T_OFF else 0
            gesture_end=(cnt_off>=N_OFF) or (len(gest_buf)>=max_g)

            # ── classify the latest window and add one vote ──────────────────
            if len(gest_buf) >= win_s:
                window = np.stack(gest_buf[-win_s:], axis=1)
                f = feats(window)
                v = model.predict(scaler.transform(f.reshape(1,-1)))[0]
                votes.append(v)

            # ── once MIN_VOTES reached, show running prediction live ─────────
            if len(votes) >= MIN_VOTES:
                vc=np.zeros(len(GESTURE_CLASSES))
                for v in votes:
                    if v<len(GESTURE_CLASSES): vc[v]+=1
                gname=GESTURE_CLASSES.get(int(np.argmax(vc)),"?")
                col=GESTURE_COLORS.get(gname,"#ffffff")
                update(label="ACTIVE", gesture=gname, color=col)
                if gname != last_printed:
                    add_log(f"  → {gname}")#  ({len(votes)} votes)")
                    print(f"[worker] live: {gname}")
                    last_printed=gname

            # ── gesture ended ────────────────────────────────────────────────
            if gesture_end:
                add_log("■  gesture end")
                if len(votes) >= MIN_VOTES:
                    vc=np.zeros(len(GESTURE_CLASSES))
                    for v in votes:
                        if v<len(GESTURE_CLASSES): vc[v]+=1
                    gname=GESTURE_CLASSES.get(int(np.argmax(vc)),"?")
                    col=GESTURE_COLORS.get(gname,"#ffffff")
                    add_log(f"★  final: {gname}  ({len(votes)} votes)")
                    print(f"[worker] final: {gname}")
                    update(label="REST", gesture=gname, color=col) #, reset_after=2.0) 
                else:
                    add_log(f"  (skipped — too short, not a gesture)")
                    update(label="REST", gesture="REST", color="#444444")
                state_=0; cnt_off=0; votes=[]

        target = t_start + (i + 1) * dt
        rem = target - time.perf_counter()
        if rem > 0: time.sleep(rem)

    update(label="DONE ✓")
    add_log("— finished —")

# ── matplotlib GUI ─────────────────────────────────────────────────────────────
def run_gui():
    plt.style.use("dark_background")
    fig = plt.figure(figsize=(6, 7), facecolor="#111111")
    fig.canvas.manager.set_window_title("EMG Gesture Classifier")

    # axes — top: gesture, mid: signal, bot: log
    ax_top = fig.add_axes([0.0,  0.62, 1.0,  0.38])  # gesture
    ax_sig = fig.add_axes([0.08, 0.30, 0.88, 0.28])  # signal plot
    ax_bot = fig.add_axes([0.0,  0.0,  1.0,  0.28])  # log

    for ax in [ax_top, ax_bot]:
        ax.set_xticks([]); ax.set_yticks([])
        ax.set_facecolor("#111111")
        for sp in ax.spines.values(): sp.set_visible(False)

    # signal axes styling
    ax_sig.set_facecolor("#1a1a2e")
    ax_sig.set_xlim(0, 500)
    ax_sig.set_ylim(0, 3.0)
    ax_sig.set_ylabel("Activation", fontsize=8, color="#888888")
    ax_sig.tick_params(colors="#555555", labelsize=7)
    ax_sig.set_xticks([])
    for sp in ax_sig.spines.values(): sp.set_color("#333333")
    sig_line, = ax_sig.plot([], [], color="#00e5ff", linewidth=1.2)
    ax_sig.axhline(T_ON,  color="#ff4081", linewidth=0.8, linestyle="--", alpha=0.7, label=f"T_ON={T_ON}")
    ax_sig.axhline(T_OFF, color="#ffd740", linewidth=0.8, linestyle="--", alpha=0.5, label=f"T_OFF={T_OFF}")
    ax_sig.legend(loc="upper right", fontsize=7, framealpha=0.3)

    # top: state + gesture
    state_txt   = ax_top.text(0.5, 0.82, "LOADING...",
                               ha="center", va="center",
                               fontsize=11, color="#cccccc",
                               fontfamily="monospace",
                               transform=ax_top.transAxes)
    gesture_txt = ax_top.text(0.5, 0.42, "—",
                               ha="center", va="center",
                               fontsize=52, fontweight="bold",
                               color="#ffffff",
                               fontfamily="monospace",
                               transform=ax_top.transAxes)

    # activation value as plain text only
    act_txt = ax_top.text(0.5, 0.10, "activation: 0.00",
                           ha="center", va="center",
                           fontsize=9, color="#cccccc",
                           fontfamily="monospace",
                           transform=ax_top.transAxes)

    # bottom: log
    log_txt = ax_bot.text(0.04, 0.95, "",
                           ha="left", va="top",
                           fontsize=8.5, color="#cccccc",
                           fontfamily="monospace",
                           transform=ax_bot.transAxes,
                           linespacing=1.6)

    plt.ion()
    plt.show()

    last_gesture = "—"
    last_color   = "#ffffff"
    smoothed_act = 0.0
    prev_ymax    = 3.0

    while plt.fignum_exists(fig.number):
        with _lock:
            dirty    = state["dirty"]
            label    = state["label"]
            gesture  = state["gesture"]
            color    = state["color"]
            act      = state["act"]
            log_lines= list(state["log"])
            sig_data = list(state["sig_buf"])
            ra = state.get("reset_after", 0.0)
            if ra > 0:
                state["reset_after"] = 0.0
                state["reset_time"] = time.time() + ra
            state["dirty"] = False

        if dirty:
            # state label
            sc = {"REST":"#cccccc","ACTIVE":"#ffd740",
                  "GESTURE START ▶":"#ffd740","CLASSIFYING...":"#e040fb",
                  "DONE ✓":"#69ff47"}
            state_txt.set_text(label)
            state_txt.set_color(sc.get(label, "#888888"))

            # gesture (flash)
            if gesture != last_gesture:
                last_gesture = gesture
                last_color   = color
            if gesture != last_gesture:
                last_gesture = gesture
                last_color   = color
            gesture_txt.set_color(last_color)
            gesture_txt.set_text(gesture)

            # activation — just show the number, colour by state
            act_col = "#ff4081" if act>T_ON else "#ffd740" if act>T_OFF else "#cccccc"
            act_txt.set_text(f"activation: {act:.2f}")
            act_txt.set_color(act_col)

            # log
            log_txt.set_text("\n".join(log_lines))

        # update signal plot
        if sig_data:
            n = len(sig_data)
            win = 500
            x_end = max(n, win)
            visible = sig_data[-win:]
            ymax = max(max(visible) * 1.2, T_ON * 1.5, 2.0)

            if abs(ymax - prev_ymax) / (prev_ymax + 1e-8) > 0.15:
                ax_sig.set_ylim(0, ymax)
                prev_ymax = ymax

            ax_sig.set_xlim(x_end - win, x_end)
            sig_line.set_data(np.arange(n - len(visible), n), visible)

        fig.canvas.draw_idle()
        fig.canvas.flush_events()

        # check if we should reset gesture back to REST
        with _lock:
            rt = state.get("reset_time", 0.0)
        if rt > 0 and time.time() >= rt:
            with _lock:
                state["reset_time"] = 0.0
                state["gesture"] = "REST"
                state["color"]   = "#444444"
                state["dirty"]   = True

        plt.pause(0.03)

# ── headless video renderer ────────────────────────────────────────────────────
def render_video():
    """Render the entire session to MP4 off-screen (no popup window)."""
    matplotlib.use("Agg")  # non-interactive backend
    import matplotlib.pyplot as plt  # re-import with Agg

    print("[render] loading data...")
    m   = loadmat(MAT_PATH)
    sig = np.array(m['Data'], dtype=float)[:, :64]
    Fs  = float(np.squeeze(m['SamplingFrequency']))
    scaler, model = joblib.load(MODEL_PATH)
    print(f"[render] {sig.shape[0]} samples @ {Fs} Hz")

    b_bp,a_bp = butter(2,[F_LOWER/(Fs/2),F_UPPER/(Fs/2)],btype='band')
    b_n,a_n   = iirnotch(F_NOTCH/(Fs/2),F_NOTCH/BW_NOTCH)
    zi_bp = np.tile(lfilter_zi(b_bp,a_bp),(64,1))
    zi_n  = np.tile(lfilter_zi(b_n, a_n), (64,1))

    def filt(x):
        nonlocal zi_bp,zi_n
        y,zi_bp[:]=lfilter(b_bp,a_bp,x[:,None],zi=zi_bp)
        y,zi_n[:] =lfilter(b_n, a_n, y,        zi=zi_n)
        return y.squeeze()

    def feats(w,thr=0.01):
        ch,_=w.shape
        MAV=np.mean(np.abs(w),axis=1)
        WL=np.sum(np.abs(np.diff(w,axis=1)),axis=1)
        ZC=np.zeros(ch);SSC=np.zeros(ch)
        for i in range(ch):
            x=w[i];s=np.diff(x)
            ZC[i]=np.sum(((x[:-1]*x[1:])<0)&(np.abs(x[:-1]-x[1:])>=thr))
            SSC[i]=np.sum(((s[:-1]*s[1:])<0)&(np.abs(s[:-1])>=thr)&(np.abs(s[1:])>=thr))
        return np.concatenate([MAV,WL,ZC,SSC])

    det_win=int(DET_WIN_MS/1000*Fs);det_step=int(DET_STEP_MS/1000*Fs)
    win_s=int(WIN_MS/1000*Fs)
    max_g=int(MAX_GESTURE_S*Fs)
    rest_mean=np.sqrt(np.mean(sig[:int(Fs*2),:]**2,axis=0))
    det_buf=deque(maxlen=det_win);gest_buf=[]
    det_ctr=0;state_=0;cnt_on=0;cnt_off=0
    log_ctr=0;votes=[];last_printed=""
    sig_buf=[];log_lines=[];label="REST";gesture="REST";color="#444444";act=0.0

    # ── set up figure ──
    plt.style.use("dark_background")
    fig = plt.figure(figsize=(6, 7), facecolor="#111111")
    ax_top = fig.add_axes([0.0,  0.62, 1.0,  0.38])
    ax_sig = fig.add_axes([0.08, 0.30, 0.88, 0.28])
    ax_bot = fig.add_axes([0.0,  0.0,  1.0,  0.28])
    for ax in [ax_top, ax_bot]:
        ax.set_xticks([]); ax.set_yticks([])
        ax.set_facecolor("#111111")
        for sp in ax.spines.values(): sp.set_visible(False)
    ax_sig.set_facecolor("#1a1a2e")
    ax_sig.set_xlim(0, 500); ax_sig.set_ylim(0, 3.0)
    ax_sig.set_ylabel("Activation", fontsize=8, color="#888888")
    ax_sig.tick_params(colors="#555555", labelsize=7); ax_sig.set_xticks([])
    for sp in ax_sig.spines.values(): sp.set_color("#333333")
    sig_line, = ax_sig.plot([], [], color="#00e5ff", linewidth=1.2)
    ax_sig.axhline(T_ON,  color="#ff4081", linewidth=0.8, linestyle="--", alpha=0.7, label=f"T_ON={T_ON}")
    ax_sig.axhline(T_OFF, color="#ffd740", linewidth=0.8, linestyle="--", alpha=0.5, label=f"T_OFF={T_OFF}")
    ax_sig.legend(loc="upper right", fontsize=7, framealpha=0.3)
    state_txt   = ax_top.text(0.5, 0.82, "REST", ha="center", va="center",
                               fontsize=11, color="#cccccc", fontfamily="monospace", transform=ax_top.transAxes)
    gesture_txt = ax_top.text(0.5, 0.42, "REST", ha="center", va="center",
                               fontsize=52, fontweight="bold", color="#ffffff", fontfamily="monospace", transform=ax_top.transAxes)
    act_txt     = ax_top.text(0.5, 0.10, "activation: 0.00", ha="center", va="center",
                               fontsize=9, color="#cccccc", fontfamily="monospace", transform=ax_top.transAxes)
    log_txt     = ax_bot.text(0.04, 0.95, "", ha="left", va="top",
                               fontsize=8.5, color="#cccccc", fontfamily="monospace",
                               transform=ax_bot.transAxes, linespacing=1.6)

    # ── video writer ──
    writer = imageio.get_writer(VIDEO_PATH, fps=VIDEO_FPS, format="FFMPEG",
                                 codec="libx264", quality=8)

    # How many raw samples between video frames
    samples_per_frame = int(Fs / VIDEO_FPS)
    prev_ymax = 3.0
    frame_ctr = 0
    total_frames = sig.shape[0] // samples_per_frame

    print(f"[render] rendering ~{total_frames} frames to {VIDEO_PATH}...")

    for i, raw in enumerate(sig):
        filtered = filt(raw - np.mean(raw))
        if state_ == 1: gest_buf.append(filtered)
        det_buf.append(filtered)
        if len(det_buf) >= det_win:
            det_ctr += 1
            if det_ctr >= det_step:
                det_ctr = 0

                w = np.stack(det_buf, axis=1)
                act = float(np.median(np.sqrt(np.mean(w**2, axis=1)) / (rest_mean + 1e-8)))

                log_ctr += 1
                if log_ctr % 5 == 0:
                    sig_buf.append(act)
                    label = "ACTIVE" if state_ else "REST"
                    if not state_: gesture = "REST"; color = "#444444"

                if state_ == 0:
                    if act > T_ON:
                        cnt_on += 1
                        if cnt_on >= N_ON:
                            label = "ACTIVE"; gesture = ""; color = "#ffffff"
                            log_lines.append("\u25b6  gesture start")
                            if len(log_lines) > 12: log_lines.pop(0)
                            state_ = 1; gest_buf = []; votes = []; last_printed = ""; cnt_on = 0
                    else: cnt_on = 0
                else:
                    gest_buf.append(filtered)
                    cnt_off = cnt_off + 1 if act < T_OFF else 0
                    gesture_end = (cnt_off >= N_OFF) or (len(gest_buf) >= max_g)
                    if len(gest_buf) >= win_s:
                        window = np.stack(gest_buf[-win_s:], axis=1)
                        f = feats(window)
                        v = model.predict(scaler.transform(f.reshape(1,-1)))[0]
                        votes.append(v)
                    if len(votes) >= MIN_VOTES:
                        vc = np.zeros(len(GESTURE_CLASSES))
                        for v in votes:
                            if v < len(GESTURE_CLASSES): vc[v] += 1
                        gname = GESTURE_CLASSES.get(int(np.argmax(vc)), "?")
                        col = GESTURE_COLORS.get(gname, "#ffffff")
                        label = "ACTIVE"; gesture = gname; color = col
                        if gname != last_printed:
                            log_lines.append(f"  \u2192 {gname}")
                            if len(log_lines) > 12: log_lines.pop(0)
                            last_printed = gname
                    if gesture_end:
                        log_lines.append("\u25a0  gesture end")
                        if len(log_lines) > 12: log_lines.pop(0)
                        if len(votes) >= MIN_VOTES:
                            vc = np.zeros(len(GESTURE_CLASSES))
                            for v in votes:
                                if v < len(GESTURE_CLASSES): vc[v] += 1
                            gname = GESTURE_CLASSES.get(int(np.argmax(vc)), "?")
                            col = GESTURE_COLORS.get(gname, "#ffffff")
                            log_lines.append(f"\u2605  final: {gname}  ({len(votes)} votes)")
                            if len(log_lines) > 12: log_lines.pop(0)
                            label = "REST"; gesture = gname; color = col
                        else:
                            log_lines.append("  (skipped \u2014 too short, not a gesture)")
                            if len(log_lines) > 12: log_lines.pop(0)
                            label = "REST"; gesture = "REST"; color = "#444444"
                        state_ = 0; cnt_off = 0; votes = []

        # ── render a frame every samples_per_frame samples ──
        if i > 0 and i % samples_per_frame == 0:
            sc = {"REST":"#cccccc","ACTIVE":"#ffd740","DONE \u2713":"#69ff47"}
            state_txt.set_text(label); state_txt.set_color(sc.get(label, "#888888"))
            gesture_txt.set_text(gesture); gesture_txt.set_color(color)
            act_col = "#ff4081" if act > T_ON else "#ffd740" if act > T_OFF else "#cccccc"
            act_txt.set_text(f"activation: {act:.2f}"); act_txt.set_color(act_col)
            log_txt.set_text("\n".join(log_lines))

            if sig_buf:
                n = len(sig_buf); win = 500
                x_end = max(n, win); visible = sig_buf[-win:]
                ymax = max(max(visible) * 1.2, T_ON * 1.5, 2.0)
                if abs(ymax - prev_ymax) / (prev_ymax + 1e-8) > 0.15:
                    ax_sig.set_ylim(0, ymax); prev_ymax = ymax
                ax_sig.set_xlim(x_end - win, x_end)
                sig_line.set_data(np.arange(n - len(visible), n), visible)

            fig.canvas.draw()
            frame = np.asarray(fig.canvas.buffer_rgba())[:, :, :3]
            writer.append_data(frame)
            frame_ctr += 1
            if frame_ctr % 100 == 0:
                print(f"[render] frame {frame_ctr}/{total_frames}")

    # final frame
    state_txt.set_text("DONE \u2713"); state_txt.set_color("#69ff47")
    log_lines.append("\u2014 finished \u2014")
    log_txt.set_text("\n".join(log_lines[-12:]))
    fig.canvas.draw()
    frame = np.asarray(fig.canvas.buffer_rgba())[:, :, :3]
    writer.append_data(frame)

    writer.close()
    plt.close(fig)
    print(f"[render] saved to {VIDEO_PATH} ({frame_ctr} frames)")

if __name__ == "__main__":
    if "--save" in sys.argv:
        render_video()
    else:
        threading.Thread(target=worker, daemon=True).start()
        run_gui()