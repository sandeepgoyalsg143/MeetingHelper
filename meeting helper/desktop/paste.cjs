const PASTE_SHORTCUT = 'Control+Alt+Shift+V';
const TYPE_SHORTCUT = 'Control+Alt+Shift+T';
const MAX_PASTE_TEXT = 24000;
const PASTE_TIMEOUT_MS = 60000;
const DEFAULT_TYPING_WPM = 40;
const MIN_TYPING_WPM = 10;
const MAX_TYPING_WPM = 150;

const releaseModifiersScript = String.raw`$deadline = [DateTime]::UtcNow.AddSeconds(2)
do {
  $modifiersDown = (([MeetingHelperInput]::GetAsyncKeyState(0x11) -band 0x8000) -ne 0) -or
    (([MeetingHelperInput]::GetAsyncKeyState(0x10) -band 0x8000) -ne 0) -or
    (([MeetingHelperInput]::GetAsyncKeyState(0x12) -band 0x8000) -ne 0) -or
    (([MeetingHelperInput]::GetAsyncKeyState(0x56) -band 0x8000) -ne 0) -or
    (([MeetingHelperInput]::GetAsyncKeyState(0x54) -band 0x8000) -ne 0)
  if (-not $modifiersDown) { break }
  Start-Sleep -Milliseconds 20
} while ([DateTime]::UtcNow -lt $deadline)
if ($modifiersDown) { exit 3 }`;

const pasteScript = String.raw`$source = @'
using System;
using System.Runtime.InteropServices;
public static class MeetingHelperInput {
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extraInfo);
}
'@
Add-Type -TypeDefinition $source
${releaseModifiersScript}
[MeetingHelperInput]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)
[MeetingHelperInput]::keybd_event(0x56, 0, 0, [UIntPtr]::Zero)
[MeetingHelperInput]::keybd_event(0x56, 0, 2, [UIntPtr]::Zero)
[MeetingHelperInput]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)`;

const typeScript = String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$source = @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class MeetingHelperInput {
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT {
    public uint type;
    public InputUnion input;
  }
  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion {
    [FieldOffset(0)] public KEYBDINPUT keyboard;
    [FieldOffset(0)] public MOUSEINPUT mouse;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public ushort wVk;
    public ushort wScan;
    public uint dwFlags;
    public uint time;
    public UIntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT {
    public int dx;
    public int dy;
    public uint mouseData;
    public uint dwFlags;
    public uint time;
    public UIntPtr dwExtraInfo;
  }
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", SetLastError = true)]
  public static extern uint SendInput(uint count, INPUT[] inputs, int size);
  private static double PauseWeight(char character) {
    if (character == '\n') return 3.5;
    if (character == ' ' || character == '\t') return 1.4;
    return ".,;:(){}[]!?".IndexOf(character) >= 0 ? 2.0 : 1.0;
  }
  public static int TypeText(string text, int wordsPerMinute) {
    var target = GetForegroundWindow();
    int sent = 0;
    if (text.Length == 0) return sent;
    var characters = 0;
    var totalWeight = 0.0;
    for (var index = 0; index < text.Length; index++) {
      characters++;
      totalWeight += PauseWeight(text[index]);
      if (Char.IsHighSurrogate(text[index]) && index + 1 < text.Length &&
          Char.IsLowSurrogate(text[index + 1])) index++;
    }
    // Normalize pauses so punctuation changes the rhythm, not the selected average speed.
    var delayUnit = (12000.0 / wordsPerMinute) * characters / totalWeight;
    var random = new Random();
    for (var index = 0; index < text.Length; index++) {
      if (target == IntPtr.Zero || GetForegroundWindow() != target) return -1;
      if ((GetAsyncKeyState(0x1B) & 0x8000) != 0) return -2;
      var length = Char.IsHighSurrogate(text[index]) && index + 1 < text.Length &&
        Char.IsLowSurrogate(text[index + 1]) ? 2 : 1;
      var inputs = new INPUT[length * 2];
      for (var offset = 0; offset < length; offset++) {
        var character = text[index + offset];
        var virtualKey = character == '\n' || character == '\t';
        var key = new KEYBDINPUT {
          wVk = virtualKey ? (ushort)(character == '\n' ? 0x0D : 0x09) : (ushort)0,
          wScan = virtualKey ? (ushort)0 : character,
          dwFlags = virtualKey ? 0u : 0x0004u
        };
        inputs[offset * 2] = new INPUT { type = 1, input = new InputUnion { keyboard = key } };
        key.dwFlags |= 0x0002;
        inputs[offset * 2 + 1] = new INPUT { type = 1, input = new InputUnion { keyboard = key } };
      }
      var accepted = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
      if (accepted != inputs.Length) return -3;
      sent += length;
      if (index + length == text.Length) return sent;

      var delay = (int)Math.Round(delayUnit * PauseWeight(text[index]) * (0.65 + random.NextDouble() * 0.7));
      while (delay > 0) {
        if (GetForegroundWindow() != target) return -1;
        if ((GetAsyncKeyState(0x1B) & 0x8000) != 0) return -2;
        var slice = Math.Min(25, delay);
        Thread.Sleep(slice);
        delay -= slice;
      }
      index += length - 1;
    }
    return sent;
  }
}
'@
Add-Type -TypeDefinition $source
${releaseModifiersScript}
$encoded = [Console]::In.ReadToEnd()
$text = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))
$text = [regex]::Replace($text, "\r\n|\r|\n", ([char]10).ToString())
$result = [MeetingHelperInput]::TypeText($text, __TYPING_WPM__)
if ($result -eq -1) { exit 6 }
if ($result -eq -2) { exit 7 }
if ($result -ne $text.Length) { exit 4 }
[Console]::Write('TYPED')`;

exports.PASTE_SHORTCUT = PASTE_SHORTCUT;
exports.TYPE_SHORTCUT = TYPE_SHORTCUT;
exports.DEFAULT_TYPING_WPM = DEFAULT_TYPING_WPM;
exports.MIN_TYPING_WPM = MIN_TYPING_WPM;
exports.MAX_TYPING_WPM = MAX_TYPING_WPM;

exports.createPasteController = ({ globalShortcut, clipboard, execFile, spawn, onStatus, logger = console }) => {
  let armed = false;
  let timer;
  let typingProcess;
  let typingCancelled = false;
  let disposed = false;

  function disarm() {
    if (!armed) return;
    armed = false;
    clearTimeout(timer);
    timer = undefined;
    globalShortcut.unregister(armedShortcut);
    armedShortcut = undefined;
  }

  let armedShortcut;

  function report(status) {
    onStatus(status);
  }

  function triggerPaste() {
    disarm();
    try {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', pasteScript], {
        windowsHide: true,
        timeout: 5000
      }, error => {
        if (error) {
          report({ ok: false, code: 'PASTE_FAILED', message: 'Could not paste into the active editor. The text remains on the clipboard; try Ctrl+V manually.' });
        } else {
          report({ ok: true, code: 'PASTED', message: 'Pasted into the active editor.' });
        }
      });
    } catch {
      report({ ok: false, code: 'PASTE_FAILED', message: 'Could not paste into the active editor. The text remains on the clipboard; try Ctrl+V manually.' });
    }
  }

  function triggerType(text, wordsPerMinute) {
    disarm();
    let child;
    let output = '';
    let completed = false;
    const finish = status => {
      if (completed) return;
      completed = true;
      if (typingProcess === child) typingProcess = undefined;
      if (disposed) return;
      if (!status.ok) logger.error(`[meeting-helper] ${status.code}`);
      report(status);
    };
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
        Buffer.from(typeScript.replace('__TYPING_WPM__', String(wordsPerMinute)), 'utf16le').toString('base64')], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      typingProcess = child;
      typingCancelled = false;
      let helperError = false;
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => { output = (output + chunk).slice(-256); });
      child.stderr.on('data', () => { helperError = true; });
      child.once('error', () => finish({
        ok: false, code: 'TYPE_FAILED',
        message: 'Could not type into the active editor. The reply remains on the clipboard; try Ctrl+V manually.'
      }));
      child.once('close', code => {
        if (completed) return;
        if (typingCancelled) {
          finish({ ok: false, code: 'CANCELLED', message: 'Typing cancelled. Review the partial text before trying again.' });
        } else if (code === 0 && !helperError && output.trim() === 'TYPED') {
          finish({ ok: true, code: 'TYPED', message: `Typed into the active editor at approximately ${wordsPerMinute} WPM.` });
        } else if (code === 6 || code === 7) {
          finish({ ok: false, code: 'TYPE_STOPPED',
            message: 'Typing stopped because focus changed or Escape was pressed. Review the partial text before trying again.' });
        } else {
          finish({
            ok: false, code: 'TYPE_FAILED',
            message: 'Typing failed. Check the editor for partial text before trying again. The full reply remains on the clipboard; Ctrl+V is available as a fallback.'
          });
        }
      });
      child.stdin.once('error', () => {
        child.kill();
        finish({ ok: false, code: 'TYPE_FAILED',
          message: 'Could not start typing. The reply remains on the clipboard; try Ctrl+V manually.' });
      });
      const encoded = Buffer.from(text, 'utf8').toString('base64');
      child.stdin.end(encoded, 'ascii');
    } catch {
      child?.kill();
      finish({
        ok: false, code: 'TYPE_FAILED',
        message: 'Could not type into the active editor. The reply remains on the clipboard; try Ctrl+V manually.'
      });
    }
  }

  return {
    prepare(text, mode = 'paste', wordsPerMinute = DEFAULT_TYPING_WPM) {
      if (disposed) return { ok: false, error: 'Insertion is no longer available. Restart the app.' };
      if (typingProcess) return { ok: false, error: 'Typing is already running. Wait for it to finish or cancel it first.' };
      if (typeof text !== 'string' || !text.trim() || text.length > MAX_PASTE_TEXT) {
        return { ok: false, error: 'Select a nonempty reply of at most 24,000 characters.' };
      }
      if (!['paste', 'type'].includes(mode)) return { ok: false, error: 'Unknown reply insertion method.' };
      if (mode === 'type' && (!Number.isInteger(wordsPerMinute) ||
          wordsPerMinute < MIN_TYPING_WPM || wordsPerMinute > MAX_TYPING_WPM)) {
        return { ok: false, error: `Typing speed must be a whole number from ${MIN_TYPING_WPM} to ${MAX_TYPING_WPM} WPM.` };
      }
      if (armed) disarm();
      clipboard.writeText(text);
      const shortcut = mode === 'type' ? TYPE_SHORTCUT : PASTE_SHORTCUT;
      const trigger = mode === 'type' ? () => triggerType(text, wordsPerMinute) : triggerPaste;
      try {
        if (!globalShortcut.register(shortcut, trigger)) {
          return { ok: false, error: `Could not register the shortcut. The reply is on the clipboard; focus the editor and press Ctrl+V.` };
        }
      } catch {
        return { ok: false, error: `Could not register the shortcut. The reply is on the clipboard; focus the editor and press Ctrl+V.` };
      }
      armed = true;
      armedShortcut = shortcut;
      timer = setTimeout(() => {
        disarm();
        report({ ok: false, code: 'EXPIRED', message: 'Insertion shortcut expired. The reply is still on the clipboard; focus the editor and press Ctrl+V.' });
      }, PASTE_TIMEOUT_MS);
      return { ok: true, shortcut, ...(mode === 'type' ? { wordsPerMinute } : {}) };
    },
    cancel() {
      if (typingProcess) {
        typingCancelled = true;
        typingProcess.kill();
        return true;
      }
      if (!armed) return false;
      disarm();
      report({ ok: false, code: 'CANCELLED', message: 'Insertion cancelled. The reply remains on the clipboard.' });
      return true;
    },
    dispose() {
      disposed = true;
      disarm();
      typingProcess?.kill();
      typingProcess = undefined;
    },
    get armed() {
      return armed;
    }
  };
};
