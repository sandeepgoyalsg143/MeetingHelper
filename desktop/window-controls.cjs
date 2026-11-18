const RESTORE_SHORTCUT = 'Control+Alt+Space';
const GHOST_SHORTCUT = 'Control+Alt+G';
const CAPTURE_SHORTCUT = 'Control+Alt+V';
const NAV_SHORTCUTS = ['Control+Alt+1', 'Control+Alt+2', 'Control+Alt+3'];

exports.createWindowControls = async ({ app, window, globalShortcut, Tray, Menu, onWarning, onOverlayState = () => {}, onNavigate = () => {}, onShowControls = () => {}, onToggleCaptureExclusion = () => {}, controlsAvailable = () => false }) => {
  let tray;
  let shortcutRegistered = false;
  let ghostShortcutRegistered = false;
  let captureShortcutRegistered = false;
  const navigationShortcuts = [false, false, false];
  let ghost = false;
  let ghostOpacity = 60;
  const overlayState = () => ({
    ghost, ghostOpacity, ghostShortcutRegistered, captureShortcutRegistered, navigationShortcuts,
    restoreShortcutRegistered: shortcutRegistered
  });
  const setOverlay = (enabled, opacity = ghostOpacity) => {
    if (typeof enabled !== 'boolean' || !Number.isInteger(opacity) || opacity < 20 || opacity > 90) {
      throw new Error('Ghost mode requires an on/off value and a whole-number opacity from 20 to 90 percent.');
    }
    if (window.isDestroyed()) throw new Error('The application window is no longer available.');
    if (enabled && !shortcutRegistered && !ghostShortcutRegistered && !tray && !controlsAvailable()) {
      throw new Error('Ghost mode is unavailable without a working restore shortcut, tray icon, or visible Quick Controls window.');
    }
    window.setOpacity(enabled ? opacity / 100 : 1);
    window.setIgnoreMouseEvents(enabled, { forward: true });
    window.setFocusable(!enabled);
    ghost = enabled;
    ghostOpacity = opacity;
    if (enabled) {
      window.setAlwaysOnTop(true, 'floating');
      if (window.isMinimized()) window.restore();
      window.showInactive();
      window.blur();
    }
    onOverlayState(overlayState());
    return overlayState();
  };
  const show = () => {
    if (window.isDestroyed()) return;
    setOverlay(false);
    if (window.isMinimized()) window.restore();
    window.show();
    window.setAlwaysOnTop(true, 'floating');
    window.moveTop();
    window.focus();
  };
  const navigate = () => {
    if (window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.setAlwaysOnTop(true, 'floating');
    if (ghost) {
      window.setOpacity(ghostOpacity / 100);
      window.setIgnoreMouseEvents(true, { forward: true });
      window.setFocusable(false);
      window.showInactive();
      window.blur();
    } else {
      window.show();
      window.moveTop();
      window.focus();
    }
  };
  const toggleGhost = () => {
    if (window.isDestroyed()) return;
    try {
      if (ghost) show();
      else setOverlay(true);
    } catch (error) {
      onWarning('Ghost mode unavailable', error.message);
    }
  };
  const toggleCaptureExclusion = () => onToggleCaptureExclusion();
  try {
    tray = new Tray(await app.getFileIcon(process.execPath, { size: 'small' }));
    tray.setToolTip('Meeting Helper - click to restore');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show Meeting Helper', click: show },
      { label: 'Show Quick Controls', click: onShowControls },
      { label: 'Minimize', click: () => { if (!window.isDestroyed()) window.minimize(); } },
      { type: 'separator' },
      { label: 'Quit Meeting Helper', click: () => app.quit() },
      { label: 'Toggle ghost mode', click: toggleGhost },
      { label: 'Toggle screen-share visibility', click: toggleCaptureExclusion }
    ]));
    tray.on('click', show);
  } catch {
    tray?.destroy();
    tray = undefined;
    onWarning('Tray icon unavailable', 'The tray icon could not be created. Restore Meeting Helper using its taskbar icon, Quick Controls, or Ctrl+Alt+Space if available.');
  }
  const shortcutWarning = () => onWarning('Restore shortcut unavailable',
    'Ctrl+Alt+Space is already in use or unavailable. Restore Meeting Helper using Quick Controls, its tray icon, or taskbar icon.');
  try {
    shortcutRegistered = globalShortcut.register(RESTORE_SHORTCUT, show);
    if (!shortcutRegistered) shortcutWarning();
  } catch {
    shortcutWarning();
  }
  try {
    ghostShortcutRegistered = globalShortcut.register(GHOST_SHORTCUT, toggleGhost);
  } catch {
    ghostShortcutRegistered = false;
  }
  try {
    captureShortcutRegistered = globalShortcut.register(CAPTURE_SHORTCUT, toggleCaptureExclusion);
  } catch {
    captureShortcutRegistered = false;
  }
  NAV_SHORTCUTS.forEach((shortcut, index) => {
    try {
      navigationShortcuts[index] = globalShortcut.register(shortcut, () => onNavigate(index + 1));
    } catch {
      navigationShortcuts[index] = false;
    }
  });
  return {
    show,
    navigate,
    setOverlay,
    toggleGhost,
    toggleCaptureExclusion,
    get overlayState() { return overlayState(); },
    shortcutRegistered,
    trayAvailable: Boolean(tray),
    dispose() {
      if (ghostShortcutRegistered) {
        globalShortcut.unregister(GHOST_SHORTCUT);
        ghostShortcutRegistered = false;
      }
      if (captureShortcutRegistered) {
        globalShortcut.unregister(CAPTURE_SHORTCUT);
        captureShortcutRegistered = false;
      }
      if (shortcutRegistered) {
        globalShortcut.unregister(RESTORE_SHORTCUT);
        shortcutRegistered = false;
      }
      NAV_SHORTCUTS.forEach((shortcut, index) => {
        if (navigationShortcuts[index]) globalShortcut.unregister(shortcut);
        navigationShortcuts[index] = false;
      });
      if (tray && !tray.isDestroyed()) tray.destroy();
    }
  };
};
