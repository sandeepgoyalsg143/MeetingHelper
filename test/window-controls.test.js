import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { createWindowControls } = createRequire(import.meta.url)('../desktop/window-controls.cjs');

const interactiveActions = [['opacity', 1], ['ignore-mouse', false, { forward: true }], ['focusable', true]];

async function fixture({ register = true, registerGhost = true, registerCapture = true, iconFails = false, trayFails = false } = {}) {
  const actions = [];
  const warnings = [];
  const handlers = {};
  const navigated = [];
  const captureToggles = [];
  let minimized = true;
  let destroyed = false;
  let trayDestroyed = false;
  let menu;
  const window = {
    isDestroyed: () => destroyed,
    setOpacity: value => actions.push(['opacity', value]),
    setIgnoreMouseEvents: (...args) => actions.push(['ignore-mouse', ...args]),
    setFocusable: value => actions.push(['focusable', value]),
    showInactive: () => actions.push(['show-inactive']),
    blur: () => actions.push(['blur']),
    isMinimized: () => minimized,
    setContentProtection: value => actions.push(['protection', value]),
    restore: () => { actions.push(['restore']); minimized = false; },
    show: () => actions.push(['show']),
    setAlwaysOnTop: (...args) => actions.push(['topmost', ...args]),
    moveTop: () => actions.push(['raise']),
    focus: () => actions.push(['focus']),
    minimize: () => { actions.push(['minimize']); minimized = true; }
  };
  const controls = await createWindowControls({
    window,
    app: {
      async getFileIcon(file, options) {
        assert.equal(file, process.execPath);
        assert.deepEqual(options, { size: 'small' });
        if (iconFails) throw new Error('icon failure');
        return 'icon';
      },
      quit: () => actions.push(['quit'])
    },
    globalShortcut: {
      register(key, callback) {
        if (key === 'Control+Alt+G') {
          if (registerGhost) handlers.ghost = callback;
          return registerGhost;
        }
        if (key === 'Control+Alt+V') {
          if (registerCapture) handlers.capture = callback;
          return registerCapture;
        }
        const navigationMatch = /^Control\+Alt\+([1-3])$/.exec(key);
        if (navigationMatch) {
          handlers.navigation ??= [];
          handlers.navigation[Number(navigationMatch[1]) - 1] = callback;
          return true;
        }
        assert.equal(key, 'Control+Alt+Space');
        if (register === 'throws') throw new Error('shortcut failure');
        if (register) handlers.shortcut = callback;
        return register;
      },
      unregister: key => actions.push(['unregister', key])
    },
    Tray: class {
      constructor(icon) { assert.equal(icon, 'icon'); }
      setToolTip(text) { assert.ok(text.includes('Meeting Helper')); }
      setContextMenu(value) { if (trayFails) throw new Error('tray failure'); menu = value; }
      on(event, handler) { handlers[event] = handler; }
      destroy() { trayDestroyed = true; actions.push(['tray-destroy']); }
      isDestroyed() { return trayDestroyed; }
    },
    Menu: { buildFromTemplate: template => template },
    onWarning: (...args) => warnings.push(args),
    onNavigate: part => navigated.push(part),
    onToggleCaptureExclusion: () => captureToggles.push(true)
  });
  return { controls, actions, warnings, handlers, menu, navigated, captureToggles, destroyWindow() { destroyed = true; } };
}

for (const trigger of ['shortcut', 'click', 'menu']) {
  test(`${trigger} restores a minimized window while preserving capture visibility, topmost and focus`, async () => {
    const { controls, handlers, menu, actions } = await fixture();
    assert.equal(controls.shortcutRegistered, true);
    assert.equal(controls.trayAvailable, true);
    if (trigger === 'menu') menu[0].click();
    else handlers[trigger]();
    assert.deepEqual(actions, [
      ...interactiveActions,
      ['restore'], ['show'], ['topmost', true, 'floating'], ['raise'], ['focus']
    ]);
  });
}

test('showing an already restored window still raises it without a second restore', async () => {
  const { controls, actions } = await fixture();
  controls.show();
  actions.length = 0;
  controls.show();
  assert.deepEqual(actions, [
    ...interactiveActions,
    ['show'], ['topmost', true, 'floating'], ['raise'], ['focus']
  ]);
});

for (const register of [false, 'throws']) {
  test(`shortcut registration ${register} warns explicitly and leaves tray restore working`, async () => {
    const { controls, warnings, handlers, actions } = await fixture({ register });
    assert.equal(controls.shortcutRegistered, false);
    assert.equal(controls.trayAvailable, true);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0][0], 'Restore shortcut unavailable');
    handlers.click();
    assert.ok(actions.some(([name]) => name === 'restore'));
    controls.dispose();
    assert.ok(!actions.some(([name, key]) => name === 'unregister' && key === 'Control+Alt+Space'));
  });
}

for (const option of ['iconFails', 'trayFails']) {
  test(`${option} warns explicitly and leaves the keyboard shortcut working`, async () => {
    const { controls, warnings, handlers, actions } = await fixture({ [option]: true });
    assert.equal(controls.trayAvailable, false);
    assert.equal(controls.shortcutRegistered, true);
    assert.equal(warnings[0][0], 'Tray icon unavailable');
    handlers.shortcut();
    assert.ok(actions.some(([name]) => name === 'restore'));
    if (option === 'trayFails') assert.ok(actions.some(([name]) => name === 'tray-destroy'));
  });
}

test('tray minimize and quit actions preserve normal lifecycle', async () => {
  const { menu, actions } = await fixture();
  menu.find(item => item.label === 'Minimize').click();
  menu.find(item => item.label === 'Quit Meeting Helper').click();
  assert.deepEqual(actions, [['minimize'], ['quit']]);
});

test('cleanup releases only the owned shortcut and tray, and can run twice', async () => {
  const { controls, actions } = await fixture();
  controls.dispose();
  controls.dispose();
  assert.deepEqual(actions, [
    ['unregister', 'Control+Alt+G'], ['unregister', 'Control+Alt+V'], ['unregister', 'Control+Alt+Space'],
    ['unregister', 'Control+Alt+1'], ['unregister', 'Control+Alt+2'],
    ['unregister', 'Control+Alt+3'], ['tray-destroy']
  ]);
});

test('screen-share shortcut toggles visibility and is exposed as registered state', async () => {
  const { controls, handlers, captureToggles, menu } = await fixture();
  assert.equal(controls.overlayState.captureShortcutRegistered, true);
  handlers.capture();
  menu.find(item => item.label === 'Toggle screen-share visibility').click();
  assert.deepEqual(captureToggles, [true, true]);
});

test('section shortcuts navigate directly to their matching part', async () => {
  const { controls, handlers, navigated } = await fixture();
  assert.deepEqual(controls.overlayState.navigationShortcuts, [true, true, true]);
  handlers.navigation[0]();
  handlers.navigation[1]();
  handlers.navigation[2]();
  assert.deepEqual(navigated, [1, 2, 3]);
});

test('section navigation keeps ghost mode click-through until explicitly toggled off', async () => {
  const { controls, actions } = await fixture();
  controls.setOverlay(true, 35);
  actions.length = 0;
  controls.navigate();
  assert.equal(controls.overlayState.ghost, true);
  assert.deepEqual(actions, [
    ['topmost', true, 'floating'], ['opacity', 0.35],
    ['ignore-mouse', true, { forward: true }], ['focusable', false], ['show-inactive'], ['blur']
  ]);
});

test('late restore callbacks do not touch a destroyed window', async () => {
  const { controls, actions, handlers, menu, destroyWindow } = await fixture();
  destroyWindow();
  controls.show();
  handlers.shortcut();
  handlers.click();
  menu.find(item => item.label === 'Minimize').click();
  assert.deepEqual(actions, []);
});

test('ghost mode is translucent, non-focusable and click-through, with a working toggle back', async () => {
  const { controls, handlers, actions } = await fixture();
  assert.equal(controls.overlayState.ghost, false);
  controls.setOverlay(false, 35);
  actions.length = 0;
  handlers.ghost();
  assert.deepEqual(actions, [
    ['opacity', 0.35], ['ignore-mouse', true, { forward: true }], ['focusable', false],
    ['topmost', true, 'floating'], ['restore'], ['show-inactive'], ['blur']
  ]);
  assert.equal(controls.overlayState.ghost, true);
  actions.length = 0;
  handlers.ghost();
  assert.equal(controls.overlayState.ghost, false);
  assert.deepEqual(actions.slice(0, 3), interactiveActions);
  assert.deepEqual(actions.at(-1), ['focus']);
  assert.equal(controls.overlayState.ghostOpacity, 35);
});

for (const trigger of ['shortcut', 'click', 'menu']) {
  test(`${trigger} always exits ghost mode before restoring interaction`, async () => {
    const { controls, handlers, menu, actions } = await fixture();
    controls.setOverlay(true, 20);
    actions.length = 0;
    if (trigger === 'menu') menu[0].click();
    else handlers[trigger]();
    assert.equal(controls.overlayState.ghost, false);
    assert.deepEqual(actions.slice(0, 3), interactiveActions);
  });
}

test('invalid overlay input cannot change window state', async () => {
  const { controls, actions } = await fixture();
  for (const [enabled, opacity] of [[1, 60], [true, null], [true, '60'], [true, 19], [true, 91], [true, 40.5]]) {
    assert.throws(() => controls.setOverlay(enabled, opacity), /whole-number/);
  }
  assert.deepEqual(actions, []);
});

test('ghost mode cannot trap the user when every recovery path is unavailable', async () => {
  const { controls, actions } = await fixture({ register: false, registerGhost: false, iconFails: true });
  assert.throws(() => controls.setOverlay(true), /restore shortcut, tray icon/);
  assert.deepEqual(actions, []);
});

test('the tray can toggle ghost mode when the ghost shortcut is unavailable', async () => {
  const { controls, menu } = await fixture({ registerGhost: false });
  assert.equal(controls.overlayState.ghostShortcutRegistered, false);
  menu.find(item => item.label === 'Toggle ghost mode').click();
  assert.equal(controls.overlayState.ghost, true);
  menu[0].click();
  assert.equal(controls.overlayState.ghost, false);
});
