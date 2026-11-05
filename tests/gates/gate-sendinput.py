# gate-sendinput.py — gate-batch1-physical-ab.mjs 的 B 通道伴随脚本
# 迁移自 docs/tmp/audit-r2/gate-sendinput.py（只读源，逻辑不变）。
# 用法: python gate-sendinput.py <pid> <durationMs> [cps=12]
# 经由 Win32 SendInput 向 ziedit 主窗真实注入键入（参照 ime-input.py 已验证口径：
#   EnumWindows 按 pid 找窗 → AttachThreadInput + SetForegroundWindow 抢前台 → KEYBDINPUT SendInput）。
# 逐字符键入（字母/数字/空格/回车），节奏 ~1/cps；前台丢失即退出码 4 并输出 JSON 说明。
# stdout 末行 JSON：{ pid, hwnd, title, focus, typedChars, durationMs, foregroundLost }
import ctypes, ctypes.wintypes as w, sys, time, json

user32 = ctypes.windll.user32
user32.SetProcessDPIAware()

class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", w.WORD), ("wScan", w.WORD), ("dwFlags", w.DWORD), ("time", w.DWORD), ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong))]
class INPUT(ctypes.Structure):
    _fields_ = [("type", w.DWORD), ("ki", KEYBDINPUT)]

def windows_of_pid(pid):
    found = []
    @ctypes.WINFUNCTYPE(ctypes.c_bool, w.HWND, w.LPARAM)
    def cb(hwnd, _):
        p = w.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(p))
        if p.value == pid and user32.IsWindowVisible(hwnd):
            found.append(hwnd)
        return True
    user32.EnumWindows(cb, 0)
    return found

def title(hwnd):
    buf = ctypes.create_unicode_buffer(512)
    user32.GetWindowTextW(hwnd, buf, 512)
    return buf.value

def foreground_ok(hwnd):
    return user32.GetForegroundWindow() == hwnd

def focus(hwnd):
    user32.ShowWindow(hwnd, 9)  # SW_RESTORE
    fg = user32.GetForegroundWindow()
    fg_tid = user32.GetWindowThreadProcessId(fg, ctypes.byref(w.DWORD()))
    cur_tid = ctypes.windll.kernel32.GetCurrentThreadId()
    attached = False
    if fg_tid != cur_tid:
        attached = bool(user32.AttachThreadInput(fg_tid, cur_tid, True))
    user32.BringWindowToTop(hwnd)
    user32.SetForegroundWindow(hwnd)
    user32.SetFocus(hwnd)
    if attached:
        user32.AttachThreadInput(fg_tid, cur_tid, False)
    for _ in range(20):
        if foreground_ok(hwnd):
            return True
        time.sleep(0.05)
    return False

def send_vk(vk, down=True):
    inp = INPUT(1, KEYBDINPUT(vk, 0, 0 if down else 2, 0, None))
    user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(inp))

def tap(vk, hold=0.03):
    send_vk(vk, True); time.sleep(hold); send_vk(vk, False)

VK_ENTER = 0x0D
def type_char(ch):
    if ch == '\n':
        tap(VK_ENTER)
    elif ch == ' ':
        tap(0x20)
    elif ch.isalpha():
        tap(ord(ch.upper()))
    elif ch.isdigit():
        tap(ord(ch))
    else:
        tap(0x20)  # 其余字符以空格代理（B 通道只关心物理注入节奏，不关心成字内容）

def main():
    pid = int(sys.argv[1])
    duration_ms = int(sys.argv[2])
    cps = float(sys.argv[3]) if len(sys.argv) > 3 else 12.0
    wins = windows_of_pid(pid)
    if not wins:
        print(json.dumps({"error": "no window for pid"})); sys.exit(2)
    hwnd = next((h for h in wins if "ziedit" in title(h)), wins[0])
    ok = focus(hwnd)
    info = {"pid": pid, "hwnd": int(hwnd), "title": title(hwnd), "focus": ok}
    if not ok:
        print(json.dumps({**info, "error": "cannot take foreground"})); sys.exit(3)
    pattern = "the quick brown fox jumps over the lazy dog 0123456789\n"
    typed = 0
    t0 = time.time()
    lost = False
    while (time.time() - t0) * 1000 < duration_ms:
        if not foreground_ok(hwnd):
            lost = True; break
        type_char(pattern[typed % len(pattern)])
        typed += 1
        time.sleep(max(0.0, 1.0 / cps - 0.03))
    info.update({"typedChars": typed, "durationMs": round((time.time() - t0) * 1000), "foregroundLost": lost})
    print(json.dumps(info, ensure_ascii=False))
    sys.exit(4 if lost else 0)

main()
