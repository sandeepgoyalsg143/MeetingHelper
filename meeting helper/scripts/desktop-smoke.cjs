const assert = require('node:assert/strict');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { createPasteController, TYPE_SHORTCUT, DEFAULT_TYPING_WPM, MIN_TYPING_WPM, MAX_TYPING_WPM } =
  require('../desktop/paste.cjs');

async function checkNativeTyping() {
  const { BrowserWindow, globalShortcut } = require('electron');
  const editor = new BrowserWindow({
    width: 480, height: 240, show: false, alwaysOnTop: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true }
  });
  editor.setContentProtection(true);
  let controller;
  let timeout;
  try {
    await editor.loadURL('data:text/html,' + encodeURIComponent(
      '<title>Meeting Helper typing test</title><textarea autofocus rows="8" cols="50"></textarea>' +
      '<script>window.inputTimes = []; document.querySelector("textarea").addEventListener("input", ' +
      '() => window.inputTimes.push(performance.now()));</script>'));
    editor.show();
    editor.moveTop();
    editor.focus();
    let triggered = 0;
    let complete;
    controller = createPasteController({
      globalShortcut: {
        register(key, callback) {
          return globalShortcut.register(key, () => { triggered++; callback(); });
        },
        unregister: key => globalShortcut.unregister(key)
      },
      clipboard: { writeText() {} },
      execFile, spawn,
      onStatus: status => complete(status)
    });
    const handle = editor.getNativeWindowHandle();
    const expectedWindow = handle.length === 8 ? handle.readBigUInt64LE().toString() : String(handle.readUInt32LE());
    const hotkeyScript = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MeetingHelperHotkeyTest {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extraInfo);
}
'@
if ([MeetingHelperHotkeyTest]::GetForegroundWindow().ToInt64() -ne ${expectedWindow}) {
  [MeetingHelperHotkeyTest]::SetForegroundWindow([IntPtr]::new(${expectedWindow})) | Out-Null
  Start-Sleep -Milliseconds 100
}
if ([MeetingHelperHotkeyTest]::GetForegroundWindow().ToInt64() -ne ${expectedWindow}) {
  [Console]::Write('FOCUS_MISMATCH')
  exit 0
}
foreach ($key in @(0x11, 0x12, 0x10, 0x54)) {
  [MeetingHelperHotkeyTest]::keybd_event($key, 0, 0, [UIntPtr]::Zero)
}
foreach ($key in @(0x54, 0x10, 0x12, 0x11)) {
  [MeetingHelperHotkeyTest]::keybd_event($key, 0, 2, [UIntPtr]::Zero)
}`;
    const text = 'int x;\n\u2713\uD83D\uDE80';
    const durations = [];
    for (const speed of [MIN_TYPING_WPM, MAX_TYPING_WPM]) {
      editor.focus();
      const deadline = Date.now() + 5000;
      while (!editor.isFocused()) {
        if (Date.now() > deadline) throw new Error('Could not focus the isolated typing test editor.');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      await editor.webContents.executeJavaScript(`
        document.querySelector('textarea').value = '';
        window.inputTimes = [];
        document.querySelector('textarea').focus();
      `);
      const prepared = controller.prepare(text, 'type', speed);
      assert.equal(prepared.ok, true, prepared.error);
      assert.equal(prepared.shortcut, TYPE_SHORTCUT);
      assert.equal(prepared.wordsPerMinute, speed);
      const finished = new Promise((resolve, reject) => {
        complete = resolve;
        timeout = setTimeout(() => reject(new Error('Native typing shortcut did not complete.')), 25000);
      });
      const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', hotkeyScript], {
        windowsHide: true, timeout: 10000
      });
      if (stdout.trim() === 'FOCUS_MISMATCH') {
        return 'skipped: Windows did not grant the smoke-test editor foreground focus';
      }
      const status = await finished;
      clearTimeout(timeout);
      if (!status.ok && status.code === 'TYPE_STOPPED') {
        return 'skipped: Windows changed foreground focus during the synthetic typing test';
      }
      assert.equal(status.ok, true, status.message);
      const result = await editor.webContents.executeJavaScript(`({
        text: document.querySelector('textarea').value,
        elapsed: window.inputTimes.at(-1) - window.inputTimes[0]
      })`);
      assert.ok(result.text === text,
        'The isolated typing test received unexpected text. Keep the keyboard idle while it runs.');
      const expected = (Array.from(text).length - 1) * 12000 / speed;
      assert.ok(result.elapsed >= expected * 0.55 && result.elapsed <= expected * 1.8 + 500,
        `Typing at ${speed} WPM took ${Math.round(result.elapsed)} ms; expected approximately ${Math.round(expected)} ms.`);
      durations.push(result.elapsed);
    }
    assert.equal(triggered, 2, 'each real Windows shortcut must fire exactly once');
    assert.ok(durations[0] > durations[1] * 5, 'the selected speed must noticeably change actual typing intervals');
    return true;
  } finally {
    clearTimeout(timeout);
    controller?.dispose();
    if (!editor.isDestroyed()) editor.destroy();
  }
}

async function checkTypingSpeedPreferences(window) {
  const evaluate = source => window.webContents.executeJavaScript(source);
  const original = await evaluate("localStorage.getItem('typing-speed-wpm')");
  const reload = () => window.loadURL(window.webContents.getURL());
  const checks = {};
  try {
    await evaluate("localStorage.removeItem('typing-speed-wpm')");
    await reload();
    checks.defaultTypingSpeed = await evaluate(`(() => {
      const input = document.getElementById('typing-speed');
      return input.type === 'range' && input.min === '${MIN_TYPING_WPM}' &&
        input.max === '${MAX_TYPING_WPM}' && input.step === '1' &&
        input.value === '${DEFAULT_TYPING_WPM}' &&
        document.getElementById('typing-speed-value').textContent === '${DEFAULT_TYPING_WPM} WPM';
    })()`);
    checks.typingSpeedReadout = await evaluate(`(() => {
      const input = document.getElementById('typing-speed');
      input.value = '55';
      input.dispatchEvent(new Event('input'));
      input.dispatchEvent(new Event('change'));
      return document.getElementById('typing-speed-value').textContent === '55 WPM' &&
        input.getAttribute('aria-valuetext') === '55 words per minute';
    })()`);
    await reload();
    checks.typingSpeedPersisted = await evaluate(`document.getElementById('typing-speed').value === '55' &&
      document.getElementById('typing-speed-value').textContent === '55 WPM'`);
    await evaluate("localStorage.setItem('typing-speed-wpm', '9')");
    await reload();
    checks.invalidSavedSpeedReported = await evaluate(`document.getElementById('typing-speed').value === '${DEFAULT_TYPING_WPM}' &&
      !document.getElementById('error').hidden && document.getElementById('error-message').textContent.includes('saved typing speed is invalid')`);
    checks.speedStorageFailureReported = await evaluate(`(() => {
      const setItem = Storage.prototype.setItem;
      try {
        Storage.prototype.setItem = () => { throw new DOMException('Storage blocked', 'SecurityError'); };
        const input = document.getElementById('typing-speed');
        input.value = '65';
        input.dispatchEvent(new Event('input'));
        input.dispatchEvent(new Event('change'));
        return input.value === '65' && document.getElementById('typing-speed-value').textContent === '65 WPM' &&
          !document.getElementById('error').hidden &&
          document.getElementById('error-message').textContent.includes('Could not save the typing speed');
      } finally { Storage.prototype.setItem = setItem; }
    })()`);
  } finally {
    await evaluate(original === null ? "localStorage.removeItem('typing-speed-wpm')" :
      `localStorage.setItem('typing-speed-wpm', ${JSON.stringify(original)})`);
    await reload();
  }
  return checks;
}

async function checkGhostOverlay(window, windowControls) {
  const evaluate = source => window.webContents.executeJavaScript(source);
  const handle = window.getNativeWindowHandle();
  const hwnd = handle.length === 8 ? handle.readBigUInt64LE().toString() : String(handle.readUInt32LE());
  const readStyle = async () => {
    const script = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OverlayStyleTest {
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr window, int index);
}
'@
[Console]::Write([OverlayStyleTest]::GetWindowLong([IntPtr]::new(${hwnd}), -20))`;
    const { stdout } = await promisify(execFile)('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 15000 });
    const style = Number(stdout.trim());
    assert.ok(Number.isInteger(style), 'Windows must return a numeric extended window style');
    return style;
  };
  const waitForGhost = async enabled => {
    await evaluate(`(async () => {
      const deadline = Date.now() + 5000;
      while (document.getElementById('ghost-mode').getAttribute('aria-pressed') !== '${enabled}') {
        if (Date.now() > deadline) throw new Error('Ghost UI state was not updated.');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    })()`);
  };
  try {
    assert.equal(windowControls.overlayState.ghost, false, 'startup must always be interactive');
    await evaluate(`(() => {
      const input = document.getElementById('ghost-opacity');
      input.value = '35';
      input.dispatchEvent(new Event('input'));
      input.dispatchEvent(new Event('change'));
    })()`);
    await evaluate(`document.getElementById('ghost-mode').click()`);
    await waitForGhost(true);
    assert.ok(Math.abs(window.getOpacity() - 0.35) < 0.005);
    assert.equal(window.isFocusable(), false);
    assert.equal(window.isAlwaysOnTop(), true);
    const ghostStyle = await readStyle();
    assert.ok(ghostStyle & 0x20, 'ghost mode must really pass Windows mouse events through');
    assert.ok(ghostStyle & 0x08000000, 'ghost mode must not activate over the underlying app');
    windowControls.show();
    await waitForGhost(false);
    assert.equal(window.getOpacity(), 1);
    assert.equal(window.isFocusable(), true);
    assert.equal((await readStyle()) & 0x20, 0, 'restoring must really re-enable Windows mouse input');
    for (const opacity of [20, 90]) {
      const result = await evaluate(`window.meetingHelper.setOverlay(true, ${opacity})`);
      assert.equal(result.ok, true);
      assert.ok(Math.abs(window.getOpacity() - opacity / 100) < 0.005);
      windowControls.show();
    }
    for (const [enabled, opacity] of [[true, 19], [true, 91], [true, '60'], [1, 60]]) {
      const result = await evaluate(`window.meetingHelper.setOverlay(${JSON.stringify(enabled)}, ${JSON.stringify(opacity)})`);
      assert.equal(result.ok, false);
      assert.equal(window.getOpacity(), 1);
      assert.equal(window.isFocusable(), true);
    }
    const privacy = await evaluate('window.meetingHelper.windowInfo()');
    assert.equal(privacy.captureExclusionRequested, true);
    await evaluate(`window.meetingHelper.setOverlay(false, 60)`);
    return { ghostOpacityControl: true, nativeClickThrough: true, ghostDoesNotTakeFocus: true,
      restoreExitsGhostMode: true, ghostOpacityRange: true, ghostInputValidated: true,
      ghostKeepsTopmostAndProtection: true };
  } finally {
    windowControls.show();
    window.hide();
  }
}

exports.run = async ({ window, controlsWindow, ipcMain, windowControls, windowControlWarnings }) => {
  assert.ok(controlsWindow && !controlsWindow.isDestroyed() && controlsWindow.isVisible(),
    'the compact controls window must open with the main app');
  assert.equal(controlsWindow.isAlwaysOnTop(), true, 'quick controls must remain accessible above other windows');
  const quickControls = await controlsWindow.webContents.executeJavaScript(`(() => ({
    navigation: [...document.querySelectorAll('[data-action^="part-"]')].map(button =>
      button.querySelector('kbd').textContent.replace(/ · unavailable$/, '')),
    ghost: Boolean(document.getElementById('toggle-ghost')),
    captureToggle: Boolean(document.getElementById('toggle-capture-exclusion')),
    windowActions: ['show-main', 'minimize-main', 'toggle-maximize'].every(action =>
      Boolean(document.querySelector('[data-action="' + action + '"]')))
  }))()`);
  assert.deepEqual(quickControls.navigation, ['Ctrl+Alt+1', 'Ctrl+Alt+2', 'Ctrl+Alt+3']);
  assert.equal(quickControls.ghost, true);
  assert.equal(quickControls.captureToggle, true);
  assert.equal(quickControls.windowActions, true);
  assert.equal(typeof windowControls.overlayState.captureShortcutRegistered, 'boolean');
  const initialCaptureState = await window.webContents.executeJavaScript('window.meetingHelper.windowInfo()');
  assert.equal(initialCaptureState.captureExclusionRequested, true);
  const visibilityToggle = await window.webContents.executeJavaScript(
    "(async () => { const button = document.getElementById('capture-exclusion-toggle'); button.click(); const deadline = Date.now() + 3000; while (!document.getElementById('capture-exclusion-status').textContent.includes('exclusion is off')) { if (Date.now() > deadline) throw new Error('Screen-share visibility did not update.'); await new Promise(resolve => setTimeout(resolve, 25)); } return window.meetingHelper.windowInfo(); })()");
  assert.equal(visibilityToggle.captureExclusionRequested, false);
  assert.match(await window.webContents.executeJavaScript(
    "document.getElementById('capture-exclusion-status').textContent"), /exclusion is off/i);
  await controlsWindow.webContents.executeJavaScript(
    "(async () => await window.meetingHelperControls.action('toggle-capture-exclusion'))()");
  const restoredCaptureState = await window.webContents.executeJavaScript('window.meetingHelper.windowInfo()');
  assert.equal(restoredCaptureState.captureExclusionRequested, true);
  await controlsWindow.webContents.executeJavaScript(
    "(async () => await window.meetingHelperControls.action('part-2'))()");
  assert.equal(await window.webContents.executeJavaScript(
    "document.getElementById('tab-2').getAttribute('aria-selected')"), 'true');
  await controlsWindow.webContents.executeJavaScript(
    "(async () => await window.meetingHelperControls.action('part-1'))()");
  assert.equal(await window.webContents.executeJavaScript(
    "document.getElementById('tab-1').getAttribute('aria-selected')"), 'true');
  await controlsWindow.webContents.executeJavaScript(
    "(async () => await window.meetingHelperControls.action('toggle-ghost'))()");
  assert.equal(windowControls.overlayState.ghost, true, 'quick controls must toggle the main window ghost mode');
  await controlsWindow.webContents.executeJavaScript(
    "(async () => await window.meetingHelperControls.action('part-2'))()");
  assert.equal(windowControls.overlayState.ghost, true, 'navigating from quick controls must preserve ghost mode');
  assert.equal(await window.webContents.executeJavaScript(
    "document.getElementById('tab-2').getAttribute('aria-selected')"), 'true');
  await controlsWindow.webContents.executeJavaScript(
    "(async () => await window.meetingHelperControls.action('toggle-ghost'))()");
  assert.equal(windowControls.overlayState.ghost, false);
  await controlsWindow.webContents.executeJavaScript(
    "(async () => await window.meetingHelperControls.action('part-1'))()");
  const overlayChecks = await checkGhostOverlay(window, windowControls);
  if (process.argv.includes('--overlay-smoke-test')) return overlayChecks;
  const { extractResume } = require('../desktop/resume.cjs');
  const Zip = require(require.resolve('jszip', { paths: [require.resolve('mammoth')] }));
  const zip = new Zip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:body><w:p><w:r><w:t>Alex: Java engineer.</w:t></w:r></w:p></w:body></w:document>');
  assert.equal(await extractResume({ name: 'resume.docx',
    data: Array.from(await zip.generateAsync({ type: 'nodebuffer' })) }), 'Alex: Java engineer.');
  const pdfStream = 'BT /F1 12 Tf 72 720 Td (Alex: Java engineer.) Tj ET';
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (const [index, object] of [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${pdfStream.length} >>\nstream\n${pdfStream}\nendstream`
  ].entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += 'xref\n0 6\n0000000000 65535 f \n' +
    offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  assert.equal(await extractResume({ name: 'resume.pdf', data: Array.from(Buffer.from(pdf)) }), 'Alex: Java engineer.');
  const waitForWindow = async predicate => {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('Window restore smoke check timed out');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  window.showInactive();
  window.minimize();
  await waitForWindow(() => window.isMinimized());
  windowControls.show();
  await waitForWindow(() => !window.isMinimized() && window.isVisible());
  assert.equal(window.isAlwaysOnTop(), true);
  assert.equal(windowControls.trayAvailable, true);
  assert.ok(windowControls.shortcutRegistered || windowControlWarnings.includes('Restore shortcut unavailable'));
  window.hide();
  const evaluate = source => window.webContents.executeJavaScript(source);
  const checks = await evaluate(`(async () => {
    const response = await window.meetingHelper.request('/api/status');
    const privacy = await window.meetingHelper.windowInfo();
    return {
      server: response.ok && response.data.configured === false,
      sapProvider: response.data.provider === 'sap-ai-core',
      model: response.data.model === 'gemini-3.5-flash',
      isolated: typeof require === 'undefined' && typeof process === 'undefined',
      ui: Boolean(document.querySelector('#composer')) && Boolean(document.querySelector('#verify')) &&
        Boolean(document.querySelector('#paste-live-answer')) && Boolean(document.querySelector('#type-live-answer')) &&
        Boolean(document.querySelector('#login-form')) && Boolean(document.querySelector('#sign-out')),
      topmost: privacy.alwaysOnTop,
      protectionRequested: privacy.captureExclusionRequested
    };
  })()`);
  checks.minimizedWindowRestored = true;
  checks.trayAvailable = windowControls.trayAvailable;
  checks.restoreShortcutHandled = true;
  const speedChecks = await checkTypingSpeedPreferences(window);
  checks.typeSpeedValidatedByMain = await evaluate(`(async () => {
    for (const speed of [null, '40', 9, 151, 40.5]) {
      const result = await window.meetingHelper.prepareType('Typing speed validation', speed);
      if (result.ok || !result.error.includes('${MIN_TYPING_WPM} to ${MAX_TYPING_WPM} WPM')) return false;
    }
    return true;
  })()`);
  const submitted = [];
  const chatResumes = [];
  const chatScreens = [];
  const liveCalls = [];
  const typePrepareCalls = [];
  let verifyFails = true;
  let chatFails = true;
  let audioFails = true;
  ipcMain.removeHandler('api-request');
  ipcMain.removeHandler('type-prepare');
  ipcMain.handle('type-prepare', (_event, text, wordsPerMinute) => {
    typePrepareCalls.push({ text, wordsPerMinute });
    return { ok: true, shortcut: 'Control+Alt+Shift+T', wordsPerMinute };
  });
  ipcMain.handle('api-request', (_event, route, body) => {
    if (route === '/api/status') return { ok: true, data: { provider: 'sap-ai-core', configured: true, verified: false, model: 'gemini-3.5-flash' } };
    if (route === '/api/verify') {
      if (verifyFails) {
        verifyFails = false;
        return { ok: false, data: {
          error: 'Test SAP authentication failure', code: 'SAP_AUTH_FAILED', retryable: false
        } };
      }
      return { ok: true, data: { textGeneration: true, audioTranscription: true } };
    }
    if (route === '/api/chat') {
      if (chatFails) {
        chatFails = false;
        return { ok: false, data: { error: 'Test network error', code: 'TIMEOUT', retryable: true } };
      }
      submitted.push(body.history);
      chatResumes.push(body.resume);
      chatScreens.push(body.screen);
      return { ok: true, data: { answer: 'A clear suggested reply.' } };
    }
    if (route === '/api/transcribe') {
      assert.equal(body.mimeType, 'audio/webm');
      assert.ok(body.data.length > 44);
      if (audioFails) {
        audioFails = false;
        return { ok: false, data: { error: 'Test transcription error', code: 'TIMEOUT', retryable: true } };
      }
      return { ok: true, data: { transcript: 'Unapproved draft' } };
    }
    if (route === '/api/live') {
      liveCalls.push(structuredClone(body));
      assert.equal(body.mimeType, 'audio/webm');
      assert.ok(body.data.length > 44);
      if (liveCalls.length === 2) return { ok: false, data: {
        error: 'Test live timeout', code: 'TIMEOUT', retryable: true
      } };
      return { ok: true, data: {
        transcript: '<img src=x onerror=alert(1)> What is next?',
        answer: liveCalls.length === 1 ? 'A live answer without approval.' : 'Updated live answer.'
      } };
    }
    throw new Error('Unexpected smoke-test route');
  });
  const ui = await evaluate(`(async () => {
    const el = id => document.getElementById(id);
    const wait = async predicate => {
      const deadline = Date.now() + 10000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error('UI smoke check timed out: ' +
          predicate.toString() + '; ' + el('audio-status').textContent + '; ' +
          el('transcript').value + '; ' + el('error-message').textContent);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    };
    await wait(() => !el('verify').disabled);
    el('verify').click();
    await wait(() => el('error-message').textContent === 'Test SAP authentication failure' && !el('verify').disabled);
    const sapAuthenticationError = !el('error').hidden && el('send').disabled &&
      el('meeting').disabled && el('microphone').disabled && el('live').disabled;
    el('verify').click();
    await wait(() => !el('send').disabled);
    const resumeFile = new DataTransfer();
    resumeFile.items.add(new File(['Alex: Java engineer.'], 'resume.txt', { type: 'text/plain' }));
    el('resume').files = resumeFile.files;
    el('resume').dispatchEvent(new Event('change'));
    await wait(() => el('resume-status').textContent.includes('Resume active'));
    const resumeLoaded = el('resume-status').textContent.includes('First-person');
    el('composer').value = '<img src=x onerror=alert(1)> Please suggest a reply.';
    el('chat-form').requestSubmit();
    await wait(() => !el('error').hidden && !el('retry').disabled);
    const failedTextPreserved = el('composer').value.includes('<img') && !document.querySelector('.message');
    el('retry').click();
    await wait(() => document.querySelectorAll('.message').length === 2 && !el('send').disabled);
    const safeText = !document.querySelector('.message img') && document.querySelector('.message p').textContent.includes('<img');
    const chatInsertionButtons = document.querySelectorAll('.message.model .paste-reply').length === 2;
    el('typing-speed').value = '73';
    el('typing-speed').dispatchEvent(new Event('input'));
    window.confirm = () => true;
    document.querySelector('.message.model .paste-reply:last-child').click();
    await wait(() => el('paste-status').textContent.startsWith('Ready.'));
    const typePrepared = el('paste-status').textContent.includes('Control+Alt+Shift+T') &&
      el('paste-status').textContent.includes('73 WPM') &&
      !el('cancel-paste').hidden;
    el('typing-speed').value = '118';
    el('typing-speed').dispatchEvent(new Event('input'));
    const typingSpeedCaptured = el('paste-status').textContent.includes('73 WPM') &&
      el('typing-speed-value').textContent === '118 WPM';
    el('consent').checked = true;
    el('consent').dispatchEvent(new Event('change'));
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true, value: async () => { throw new DOMException('Denied', 'NotAllowedError'); }
    });
    el('microphone').click();
    await wait(() => el('error-message').textContent.includes('denied'));
    const permissionError = !el('error').hidden && !el('microphone').disabled;
    const audio = new AudioContext();
    const destination = audio.createMediaStreamDestination();
    const oscillator = audio.createOscillator();
    oscillator.connect(destination);
    oscillator.start();
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true, value: async () => destination.stream
    });
    el('microphone').click();
    await wait(() => el('audio-status').textContent.includes('Recording microphone'));
    const captureRoutedToResponses = el('tab-3').getAttribute('aria-selected') === 'true' &&
      !el('part-3').hidden && el('stop').isConnected && !el('stop').disabled;
    await new Promise(resolve => setTimeout(resolve, 300));
    el('stop').click();
    await wait(() => el('error-message').textContent === 'Test transcription error' && !el('retry').disabled);
    const transcriptionError = !el('error').hidden && el('approve').disabled;
    el('retry').click();
    await wait(() => el('transcript').value === 'Unapproved draft' && !el('approve').disabled);
    const noAutomaticChat = document.querySelectorAll('.message').length === 2 && el('composer').value === '';
    el('transcript').value = 'Edited and approved transcript';
    el('transcript').dispatchEvent(new Event('input'));
    el('approve').click();
    const approvalIsExplicit = el('composer').value === 'Edited and approved transcript' && el('transcript-panel').hidden;
    el('chat-form').requestSubmit();
    await wait(() => document.querySelectorAll('.message').length === 4 && !el('send').disabled);
    oscillator.stop();
    await audio.close();
    const meetingAudio = new AudioContext();
    const meetingDestination = meetingAudio.createMediaStreamDestination();
    const canvas = document.createElement('canvas');
    const video = canvas.captureStream(1).getVideoTracks()[0];
    const capture = new MediaStream([...meetingDestination.stream.getAudioTracks(), video]);
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
      configurable: true, value: async () => capture
    });
    window.confirm = () => true;
    el('meeting').click();
    await wait(() => el('audio-status').textContent.includes('Recording computer audio'));
    const videoDiscarded = video.readyState === 'ended' && capture.getAudioTracks()[0].readyState === 'live';
    await new Promise(resolve => setTimeout(resolve, 300));
    el('stop').click();
    await wait(() => el('transcript').value === 'Unapproved draft' && !el('approve').disabled);
    const meetingDraftOnly = document.querySelectorAll('.message').length === 4;
    el('discard').click();
    const discardWorks = el('transcript-panel').hidden && el('transcript').value === '';
    window.confirm = () => false;
    el('live').click();
    const liveConsentRequired = el('stop').disabled && el('live-panel').hidden;
    const liveAudio = new AudioContext();
    const liveDestination = liveAudio.createMediaStreamDestination();
    const liveTone = liveAudio.createOscillator();
    liveTone.connect(liveDestination);
    liveTone.start();
    await liveAudio.resume();
    const nativeReadAudio = AnalyserNode.prototype.getFloatTimeDomainData;
    let syntheticSpeech = true;
    AnalyserNode.prototype.getFloatTimeDomainData = function (samples) {
      samples.fill(syntheticSpeech ? 0.05 : 0);
    };
    const liveVideo = canvas.captureStream(1).getVideoTracks()[0];
    const liveCapture = new MediaStream([...liveDestination.stream.getAudioTracks(), liveVideo]);
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
      configurable: true, value: async () => liveCapture
    });
    window.confirm = () => true;
    const liveStarted = performance.now();
    el('live').click();
    await new Promise(resolve => setTimeout(resolve, 600));
    const liveDetectedSpeech = el('live-status').textContent.startsWith('Speech detected');
    const liveSpeakerStoppedAt = performance.now();
    syntheticSpeech = false;
    await new Promise(resolve => setTimeout(resolve, 1700));
    const liveWaitsForSilence = el('live-answer').textContent === 'Waiting for a question...';
    await wait(() => el('live-answer').textContent === 'A live answer without approval.');
    const liveAutomatic = !el('stop').disabled && performance.now() - liveSpeakerStoppedAt >= 1900 &&
      el('transcript').value === '' && el('composer').value === '' &&
      document.querySelectorAll('.message').length === 4 && !el('live-panel').hidden;
    const liveSafeRendering = !el('live-panel').querySelector('img') &&
      el('live-transcript').textContent.includes('<img') && liveVideo.readyState === 'ended';
    syntheticSpeech = true;
    await wait(() => el('live-status').textContent.startsWith('Speech detected'));
    syntheticSpeech = false;
    await wait(() => el('error-message').textContent === 'Test live timeout' && !el('retry').disabled);
    const liveFailureStopsCapture = el('stop').disabled && liveCapture.getAudioTracks()[0].readyState === 'ended';
    el('retry').click();
    await wait(() => el('live-answer').textContent === 'Updated live answer.' && !el('live').disabled);
    const liveRetry = el('error').hidden && el('stop').disabled;
    AnalyserNode.prototype.getFloatTimeDomainData = nativeReadAudio;
    const triggerSilence = document.querySelector('input[name="live-trigger"][value="silence"]');
    const triggerManual = document.querySelector('input[name="live-trigger"][value="manual"]');
    const triggerEnabledAfterLive = !el('live-trigger').disabled && !triggerManual.disabled;
    triggerManual.click();
    const triggerChangedAfterLive = triggerManual.checked && !triggerSilence.checked;
    const manualVideo = canvas.captureStream(1).getVideoTracks()[0];
    const manualDestination = liveAudio.createMediaStreamDestination();
    liveTone.connect(manualDestination);
    const manualCapture = new MediaStream([...manualDestination.stream.getAudioTracks(), manualVideo]);
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
      configurable: true, value: async () => manualCapture
    });
    el('live').click();
    await wait(() => !el('send-audio').disabled);
    await new Promise(resolve => setTimeout(resolve, 2600));
    const manualWaitsForSend = el('live-answer').textContent === 'Waiting for a question...' &&
      el('resume').disabled && el('live-trigger').disabled;
    el('send-audio').click();
    await wait(() => el('live-answer').textContent === 'Updated live answer.' && !el('send-audio').disabled);
    const manualKeepsListening = !el('stop').disabled;
    const liveTypeButtonEnabled = !el('type-live-answer').disabled;
    el('type-live-answer').click();
    await wait(() => el('paste-status').textContent.includes('118 WPM'));
    const liveTypePrepared = el('paste-status').textContent.includes('Control+Alt+Shift+T');
    el('stop').click();
    await wait(() => !el('live').disabled);
    triggerSilence.click();
    const triggerChangeableAfterStop = !el('live-trigger').disabled && triggerSilence.checked && !triggerManual.checked;
    triggerManual.click();
    el('clear-resume').click();
    const resumeCleared = el('resume-status').textContent.startsWith('No resume.');
    el('new-chat').click();
    const clearWorks = !document.querySelector('.message') && !el('empty').hidden &&
      el('live-panel').hidden && el('live-transcript').textContent === '' && el('live-answer').textContent === '';
    const screenOffByDefault = el('include-screen').disabled && !el('include-screen').checked && el('stop-screen').hidden;
    el('choose-screen').click();
    await wait(() => !el('screen-sources').hidden && el('screen-sources').querySelector('button'));
    const ownWindowExcluded = ![...el('screen-sources').querySelectorAll('button')]
      .some(button => button.title === document.title || button.title === 'Meeting Helper Controls');
    el('screen-sources').querySelector('button').click();
    const screenSelected = el('screen-sources').hidden && el('include-screen').checked &&
      !el('include-screen').disabled && !el('stop-screen').hidden;
    el('composer').value = 'What is on my screen?';
    el('send').click();
    await wait(() => document.querySelectorAll('.message').length === 2 && !el('send').disabled);
    const screenAttachedTag = document.querySelector('.message.user .tag')?.textContent === 'Screen attached';
    el('stop-screen').click();
    const screenStopped = el('include-screen').disabled && !el('include-screen').checked &&
      el('screen-status').textContent.startsWith('Off.');
    await meetingAudio.close();
    liveTone.stop();
    await liveAudio.close();
    return {
      sapAuthenticationError, failedTextPreserved, safeText, permissionError, transcriptionError, noAutomaticChat,
      approvalIsExplicit, videoDiscarded, meetingDraftOnly, discardWorks, clearWorks,
      liveConsentRequired, liveDetectedSpeech, liveWaitsForSilence, liveAutomatic, liveSafeRendering,
      liveFailureStopsCapture, liveRetry, resumeLoaded, resumeCleared, manualWaitsForSend, manualKeepsListening,
            chatInsertionButtons, typePrepared, typingSpeedCaptured, liveTypeButtonEnabled, liveTypePrepared,
            captureRoutedToResponses,
            triggerEnabledAfterLive, triggerChangedAfterLive, triggerChangeableAfterStop,
            screenOffByDefault, ownWindowExcluded, screenSelected, screenAttachedTag, screenStopped
          };
  })()`);
  assert.equal(submitted.length, 3);
  assert.equal(submitted[0].length, 1);
  assert.equal(submitted[1].length, 3);
  assert.equal(submitted[1][2].text, 'Edited and approved transcript');
  assert.deepEqual(submitted[2], [{ role: 'user', text: 'What is on my screen?' }]);
  assert.deepEqual(chatResumes, ['Alex: Java engineer.', 'Alex: Java engineer.', undefined]);
  assert.deepEqual(chatScreens.slice(0, 2), [undefined, undefined], 'screen is never sent unless chosen');
  assert.equal(chatScreens[2].mimeType, 'image/jpeg');
  assert.equal(Buffer.from(chatScreens[2].data, 'base64').subarray(0, 2).toString('hex'), 'ffd8',
    'a real JPEG snapshot of the chosen source is attached');
  assert.deepEqual(typePrepareCalls, [
    { text: 'A clear suggested reply.', wordsPerMinute: 73 },
    { text: 'Updated live answer.', wordsPerMinute: 118 }
  ]);
  assert.equal(liveCalls.length, 4, 'manual mode submits only on Send, never on silence or Stop');
  assert.ok(liveCalls.every(call => call.resume === 'Alex: Java engineer.'));
  assert.deepEqual(liveCalls[0].history, []);
  assert.equal(liveCalls[1].history.length, 2);
  assert.deepEqual(liveCalls[2].history, liveCalls[1].history, 'failed clips must not duplicate live context');
  window.webContents.send('paste-status', { ok: false, code: 'TYPE_FAILED', message: 'Test typing failure' });
  const insertionErrorVisible = await evaluate(`(async () => {
    const error = document.getElementById('error');
    const deadline = Date.now() + 3000;
    while (document.getElementById('error-message').textContent !== 'Test typing failure') {
      if (Date.now() > deadline) throw new Error('Typing failure was not displayed.');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const rect = error.getBoundingClientRect();
    return !error.hidden && rect.top >= 0 && rect.bottom <= innerHeight;
  })()`);
  controlsWindow.hide();
  windowControls.show();
  const nativeTypingShortcut = await checkNativeTyping();
  return { ...checks, ...overlayChecks, ...speedChecks, ...ui, conversationHistory: true, liveContext: true,
    insertionErrorVisible, nativeTypingShortcut };
};
