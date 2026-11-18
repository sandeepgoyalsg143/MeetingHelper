const { app, BrowserWindow, desktopCapturer, ipcMain, session, dialog, globalShortcut, Tray, Menu, clipboard, screen } = require('electron');
const { createWindowControls } = require('./window-controls.cjs');
const { createPasteController } = require('./paste.cjs');
require('../config/load-env.cjs')();
const { fork, execFile, spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const smokeTest = process.argv.includes('--smoke-test') || process.argv.includes('--overlay-smoke-test');
const rendererUrl = pathToFileURL(path.join(__dirname, 'index.html')).href;
const controlsUrl = pathToFileURL(path.join(__dirname, 'controls.html')).href;
const routes = new Set(['/api/status', '/api/verify', '/api/chat', '/api/transcribe', '/api/live']);
let child;
let window;
let controlsWindow;
let baseUrl;
let quitting = false;
let windowControls;
let pasteController;
let captureExcluded = true;
const windowControlWarnings = [];
const token = randomBytes(32).toString('hex');

function trusted(event) {
  return window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame &&
    event.senderFrame.url === rendererUrl;
}

function publishControlsState() {
  if (!controlsWindow || controlsWindow.isDestroyed() || !window || window.isDestroyed()) return;
  controlsWindow.webContents.send('controls-state', {
    ...windowControls?.overlayState,
    captureExcluded,
    restoreShortcutRegistered: windowControls?.shortcutRegistered ?? false,
    minimized: window.isMinimized(),
    maximized: window.isMaximized()
  });
}

function setCaptureExclusion(excluded) {
  if (typeof excluded !== 'boolean') throw new TypeError('Screen-share visibility must be enabled or disabled.');
  if (!window || window.isDestroyed()) throw new Error('The application window is no longer available.');
  window.setContentProtection(excluded);
  if (controlsWindow && !controlsWindow.isDestroyed()) controlsWindow.setContentProtection(excluded);
  captureExcluded = excluded;
  if (!window.webContents.isDestroyed()) {
    window.webContents.send('capture-exclusion-state', { captureExcluded });
  }
  publishControlsState();
  return { captureExcluded, captureShortcutRegistered: windowControls?.overlayState.captureShortcutRegistered ?? false };
}

function toggleCaptureExclusion() {
  try {
    return setCaptureExclusion(!captureExcluded);
  } catch (error) {
    console.error('[meeting-helper] Screen-share visibility toggle failed.');
    dialog.showErrorBox('Screen-share visibility unavailable', error.message);
    return { captureExcluded, error: error.message };
  }
}

function trustedControls(event) {
  return controlsWindow && event.sender === controlsWindow.webContents &&
    event.senderFrame === controlsWindow.webContents.mainFrame && event.senderFrame.url === controlsUrl;
}

function showControls() {
  if (!controlsWindow || controlsWindow.isDestroyed()) return;
  if (controlsWindow.isMinimized()) controlsWindow.restore();
  controlsWindow.show();
  controlsWindow.setAlwaysOnTop(true, 'floating');
  controlsWindow.moveTop();
  publishControlsState();
}

async function startServer() {
  const serverEnvironment = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    NODE_USE_SYSTEM_CA: process.env.NODE_USE_SYSTEM_CA || '1',
    SERVER_TOKEN: token
  };
  if (smokeTest) {
    for (const name of Object.keys(serverEnvironment)) {
      if (/^(SAP_AI_CORE_|GEMINI_)/.test(name)) delete serverEnvironment[name];
    }
  }
  return new Promise((resolve, reject) => {
    child = fork(path.join(__dirname, '..', 'server', 'index.js'), [], {
      execPath: process.execPath,
      env: serverEnvironment,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc']
    });
    const timeout = setTimeout(() => reject(new Error('Local AI server startup timed out.')), 15000);
    child.once('error', () => {
      clearTimeout(timeout);
      reject(new Error('Could not launch the local AI server.'));
    });
    child.once('exit', () => {
      clearTimeout(timeout);
      if (!baseUrl) reject(new Error('The local AI server exited before starting.'));
      else if (!quitting) {
        dialog.showErrorBox('Meeting Helper', 'The local AI server stopped. Restart the application.');
        app.quit();
      }
    });
    child.on('message', (message) => {
      if (message?.type === 'startup-error') {
        clearTimeout(timeout);
        reject(new Error(message.message));
        return;
      }
      if (message?.type !== 'ready' || !Number.isInteger(message.port)) return;
      clearTimeout(timeout);
      baseUrl = `http://127.0.0.1:${message.port}`;
      resolve();
    });
  });
}

app.whenReady().then(async () => {
  if (process.platform !== 'win32') throw new Error('Meeting Helper currently supports Windows only.');
  await startServer();
  window = new BrowserWindow({
    width: 540, height: 820, minWidth: 420, minHeight: 600,
    show: false, alwaysOnTop: true, backgroundColor: '#0e1420',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true, devTools: smokeTest
    }
  });
  window.setContentProtection(true);
  window.setAlwaysOnTop(true, 'floating');
  for (const event of ['maximize', 'unmaximize', 'minimize', 'restore', 'show']) {
    window.on(event, publishControlsState);
  }
  window.on('closed', () => {
    if (!quitting) app.quit();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  const ownSession = session.defaultSession;
  ownSession.setPermissionCheckHandler((webContents, permission) =>
    webContents === window.webContents && permission === 'media');
  ownSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(webContents === window.webContents && permission === 'media' &&
      details.mediaTypes?.every(type => type === 'audio'));
  });
  ownSession.setDisplayMediaRequestHandler(async (request, callback) => {
    if (!request.userGesture || request.frame !== window.webContents.mainFrame) {
      callback({});
      return;
    }
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'], thumbnailSize: { width: 0, height: 0 }
      });
      if (!sources.length) { callback({}); return; }
      // Windows loopback includes all sound sent to the output device, not only Teams/Zoom.
      callback({ video: sources[0], audio: 'loopback' });
    } catch {
      console.error('[meeting-helper] Desktop audio capture could not start.');
      callback({});
    }
  });
  ipcMain.handle('window-info', event => {
    if (!trusted(event)) throw new Error('Untrusted window.');
    return { captureExclusionRequested: captureExcluded, alwaysOnTop: window.isAlwaysOnTop(),
      ...windowControls?.overlayState };
  });
  ipcMain.handle('resume-read', async (event, file) => {
    if (!trusted(event)) throw new Error('Untrusted window.');
    try {
      return { ok: true, text: await require('./resume.cjs').extractResume(file) };
    } catch {
      return { ok: false, error: 'Could not read the resume. Use a valid text-based PDF, DOCX or UTF-8 TXT, at most 2 MiB and 24,000 characters. Scanned PDFs require OCR first.' };
    }
  });
  ipcMain.handle('screen-sources', async event => {
    if (!trusted(event)) throw new Error('Untrusted window.');
    try {
      const ownIds = [window, controlsWindow].filter(candidate => candidate && !candidate.isDestroyed())
        .map(candidate => candidate.getMediaSourceId().split(':').slice(0, 2).join(':'));
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'], thumbnailSize: { width: 240, height: 135 }, fetchWindowIcons: false
      });
      return { ok: true, sources: sources
        .filter(source => !ownIds.some(ownId => source.id.startsWith(`${ownId}:`)) && !source.thumbnail.isEmpty())
        .slice(0, 40)
        .map(source => ({ id: source.id, name: source.name.slice(0, 120), thumbnail: source.thumbnail.toDataURL() })) };
    } catch {
      return { ok: false, error: 'Could not list screens and windows. Check Windows screen capture permissions.' };
    }
  });
  ipcMain.handle('screen-capture', async (event, id) => {
    if (!trusted(event)) throw new Error('Untrusted window.');
    if (typeof id !== 'string' || !/^(screen|window):[\d:-]+$/.test(id)) return { ok: false, error: 'Invalid screen source.' };
    try {
      const sources = await desktopCapturer.getSources({
        types: [id.startsWith('screen:') ? 'screen' : 'window'],
        thumbnailSize: { width: 1920, height: 1920 }, fetchWindowIcons: false
      });
      let image = sources.find(source => source.id === id)?.thumbnail;
      if (!image || image.isEmpty()) {
        return { ok: false, error: 'The selected screen or window is closed or minimized. Restore it or choose another.' };
      }
      if (image.getSize().width > 1600) image = image.resize({ width: 1600, quality: 'good' });
      let jpeg = image.toJPEG(80);
      if (jpeg.length > 3.5 * 1024 * 1024) jpeg = image.toJPEG(55);
      return { ok: true, mimeType: 'image/jpeg', data: jpeg.toString('base64') };
    } catch {
      return { ok: false, error: 'Could not capture the selected screen. Choose it again.' };
    }
  });
  ipcMain.handle('api-request', async (event, route, body) => {
    if (!trusted(event) || !routes.has(route)) throw new Error('API request not allowed.');
    try {
      const response = await fetch(`${baseUrl}${route}`, {
        method: route === '/api/status' ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(route === '/api/status' ? {} : { body: JSON.stringify(body ?? {}) }),
        signal: AbortSignal.timeout(route === '/api/verify' ? 240000 : 100000)
      });
      return { ok: response.ok, status: response.status, data: await response.json() };
    } catch {
      return { ok: false, status: 503, data: {
        error: 'The local AI server is unreachable or timed out. Check connectivity or restart the app.',
        code: 'LOCAL_SERVER_UNREACHABLE', retryable: true
      } };
    }
  });
  await window.loadFile(path.join(__dirname, 'index.html'));
  windowControls = await createWindowControls({
    app, window, globalShortcut, Tray, Menu,
    onShowControls: showControls,
    onToggleCaptureExclusion: toggleCaptureExclusion,
    controlsAvailable: () => Boolean(controlsWindow && !controlsWindow.isDestroyed() && controlsWindow.isVisible()),
    onOverlayState(state) {
      if (!window.isDestroyed()) window.webContents.send('overlay-state', { ...state, captureExcluded });
      publishControlsState();
    },
    onNavigate(part) {
      if (window && !window.isDestroyed()) {
        windowControls.navigate();
        window.webContents.send('navigate-part', part);
      }
    },
    onWarning(title, message) {
      windowControlWarnings.push(title);
      console.error(`[meeting-helper] ${title}`);
      if (!smokeTest) dialog.showErrorBox(title, message);
    }
  });
  window.webContents.send('overlay-state', { ...windowControls.overlayState, captureExcluded });
  const workArea = screen.getPrimaryDisplay().workArea;
  controlsWindow = new BrowserWindow({
    x: workArea.x + workArea.width - 286,
    y: workArea.y + 48,
    width: 270,
    height: 390,
    minWidth: 270,
    maxWidth: 270,
    minHeight: 390,
    maxHeight: 390,
    frame: false,
    resizable: false,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#111a28',
    webPreferences: {
      preload: path.join(__dirname, 'controls-preload.cjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true, devTools: smokeTest
    }
  });
  controlsWindow.setContentProtection(captureExcluded);
  controlsWindow.setAlwaysOnTop(true, 'floating');
  controlsWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  controlsWindow.webContents.on('will-navigate', event => event.preventDefault());
  controlsWindow.on('closed', () => { controlsWindow = undefined; });
  await controlsWindow.loadFile(path.join(__dirname, 'controls.html'));
  controlsWindow.show();
  controlsWindow.setAlwaysOnTop(true, 'floating');
  publishControlsState();
  ipcMain.handle('controls-show', event => {
    if (!trusted(event)) throw new Error('Untrusted window.');
    showControls();
    return { ok: true };
  });
  ipcMain.handle('controls-action', (event, action) => {
    if (!trustedControls(event) || typeof action !== 'string') throw new Error('Untrusted window action.');
    if (action === 'hide-controls') {
      controlsWindow.hide();
      return { ok: true };
    }
    if (action === 'toggle-ghost') {
      windowControls.toggleGhost();
      return { ok: true };
    }
    if (action === 'toggle-capture-exclusion') {
      return { ok: true, ...toggleCaptureExclusion() };
    }
    if (action === 'show-main') {
      windowControls.show();
      return { ok: true };
    }
    if (action === 'minimize-main') {
      window.minimize();
      return { ok: true };
    }
    if (action === 'toggle-maximize') {
      if (window.isMinimized()) window.restore();
      if (window.isMaximized()) window.unmaximize();
      else window.maximize();
      window.setAlwaysOnTop(true, 'floating');
      return { ok: true };
    }
    const part = /^part-([1-3])$/.exec(action);
    if (part) {
      windowControls.navigate();
      window.webContents.send('navigate-part', Number(part[1]));
      return { ok: true };
    }
    return { ok: false, error: 'Unknown controls action.' };
  });
  ipcMain.handle('overlay-set', (event, enabled, opacity) => {
    if (!trusted(event)) throw new Error('Untrusted window.');
    try {
      return { ok: true, ...windowControls.setOverlay(enabled, opacity) };
    } catch (error) {
      console.error('[meeting-helper] Overlay setting failed.');
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle('capture-exclusion-set', (event, excluded) => {
    if (!trusted(event)) throw new Error('Untrusted window.');
    try {
      return { ok: true, ...setCaptureExclusion(excluded) };
    } catch (error) {
      console.error('[meeting-helper] Screen-share visibility setting failed.');
      return { ok: false, error: error.message };
    }
  });
  pasteController = createPasteController({
    globalShortcut, clipboard, execFile, spawn,
    onStatus(status) {
      if (window && !window.isDestroyed()) {
        window.webContents.send('paste-status', status);
        if (!status.ok) windowControls.show();
        showControls();
      }
    }
  });
  ipcMain.handle('paste-prepare', (event, text) => {
    if (!trusted(event)) throw new Error('Untrusted window.');
    const result = pasteController.prepare(text);
    if (result.ok) {
      window.hide();
      controlsWindow?.hide();
    }
    return result;
  });
  ipcMain.handle('type-prepare', (event, text, wordsPerMinute) => {
    if (!trusted(event)) throw new Error('Untrusted window.');
    const result = pasteController.prepare(text, 'type', wordsPerMinute);
    if (result.ok) {
      window.hide();
      controlsWindow?.hide();
    }
    return result;
  });
  ipcMain.handle('paste-cancel', event => {
    if (!trusted(event)) throw new Error('Untrusted window.');
    return pasteController.cancel();
  });
  if (!smokeTest) window.show();
  else {
    const checks = await require('../scripts/desktop-smoke.cjs').run({
      window, controlsWindow, ipcMain, windowControls, windowControlWarnings
    });
    console.info('Desktop smoke checks:', JSON.stringify(checks));
    if (Object.values(checks).some(value => !value)) app.exit(1);
    else app.quit();
  }
}).catch(error => {
  console.error(error.message);
  if (!smokeTest) dialog.showErrorBox('Meeting Helper startup failed', error.message);
  app.exit(1);
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  quitting = true;
  if (child?.connected) child.disconnect();
});
app.on('will-quit', () => {
  if (controlsWindow && !controlsWindow.isDestroyed()) controlsWindow.destroy();
  windowControls?.dispose();
  pasteController?.dispose();
  if (child && child.exitCode === null) child.kill();
});
