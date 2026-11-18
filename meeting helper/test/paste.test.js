import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';

const { createPasteController, PASTE_SHORTCUT, TYPE_SHORTCUT,
  DEFAULT_TYPING_WPM, MIN_TYPING_WPM, MAX_TYPING_WPM } =
  createRequire(import.meta.url)('../desktop/paste.cjs');

function fixture({ register = true } = {}) {
  const handlers = new Map();
  const clipboard = [];
  const commands = [];
  const typeProcesses = [];
  const statuses = [];
  const logs = [];
  const controller = createPasteController({
    globalShortcut: {
      register(key, callback) {
        if (!register) return false;
        handlers.set(key, callback);
        return true;
      },
      unregister(key) { handlers.delete(key); }
    },
    clipboard: { writeText: value => clipboard.push(value) },
    execFile(...args) { commands.push(args); },
    spawn(...args) {
      const child = new EventEmitter();
      child.stdin = new EventEmitter();
      child.stdin.end = (script, encoding) => process.script.push(Buffer.from(script, encoding));
      child.stdout = new EventEmitter();
      child.stdout.setEncoding = () => {};
      child.stdout.write = value => child.stdout.emit('data', value);
      child.stderr = new EventEmitter();
      child.kill = () => { child.killed = true; };
      const process = { args, child, script: [] };
      typeProcesses.push(process);
      child.stdin.on('data', chunk => { process.script.push(chunk); });
      return child;
    },
    onStatus: status => statuses.push(status),
    logger: { error: message => logs.push(message) }
  });
  return { controller, handlers, clipboard, commands, typeProcesses, statuses, logs };
}

test('prepares selected text for a one-shot paste shortcut', () => {
  const { controller, handlers, clipboard, commands } = fixture();
  const result = controller.prepare('int main() { return 0; }');
  assert.deepEqual(result, { ok: true, shortcut: PASTE_SHORTCUT });
  assert.equal(clipboard[0], 'int main() { return 0; }');
  assert.equal(controller.armed, true);
  handlers.get(PASTE_SHORTCUT)();
  assert.equal(controller.armed, false);
  assert.equal(commands.length, 1);
  assert.equal(commands[0][0], 'powershell.exe');
  assert.match(commands[0][1][3], /keybd_event/);
  assert.match(commands[0][1][3], /GetAsyncKeyState/);
  assert.doesNotMatch(commands[0][1][3], /notepad|ProcessName/i);
});

test('rejects invalid text and reports when the global shortcut is unavailable', () => {
  const empty = fixture();
  assert.equal(empty.controller.prepare('  ').ok, false);
  assert.equal(empty.clipboard.length, 0);
  const unavailable = fixture({ register: false });
  assert.equal(unavailable.controller.prepare('reply').ok, false);
  assert.equal(unavailable.clipboard[0], 'reply');
  assert.equal(unavailable.controller.armed, false);
});

test('cancels a pending paste and unregisters only its shortcut', () => {
  const { controller, handlers, statuses } = fixture();
  controller.prepare('reply');
  assert.equal(controller.cancel(), true);
  assert.equal(controller.cancel(), false);
  assert.equal(handlers.has(PASTE_SHORTCUT), false);
  assert.equal(statuses.at(-1).code, 'CANCELLED');
});

test('reports paste completion for the active editor', () => {
  const { controller, handlers, commands, statuses } = fixture();
  controller.prepare('reply');
  handlers.get(PASTE_SHORTCUT)();
  const callback = commands[0][3];
  callback(null, '');
  assert.equal(statuses.at(-1).code, 'PASTED');
  controller.prepare('reply');
  handlers.get(PASTE_SHORTCUT)();
  commands[1][3](new Error('PowerShell unavailable'), '');
  assert.equal(statuses.at(-1).code, 'PASTE_FAILED');
});

test('types the selected text through a one-shot Unicode keyboard shortcut', () => {
  const { controller, handlers, clipboard, typeProcesses, statuses } = fixture();
  const text = 'int main() {\n  return "\u2713";\n}';
  const result = controller.prepare(text, 'type', 37);
  assert.deepEqual(result, { ok: true, shortcut: TYPE_SHORTCUT, wordsPerMinute: 37 });
  assert.equal(clipboard[0], text, 'clipboard remains available as a fallback');
  handlers.get(TYPE_SHORTCUT)();
  const process = typeProcesses[0];
  assert.equal(process.args[0], 'powershell.exe');
  assert.equal(process.args[1].at(-2), '-EncodedCommand');
  const script = Buffer.from(process.args[1].at(-1), 'base64').toString('utf16le');
  const encoded = Buffer.concat(process.script).toString('ascii');
  assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), text);
  assert.match(script, /SendInput/);
  assert.match(script, /using System\.Threading;/);
  assert.match(script, /virtualKey \? 0u : 0x0004u/);
  assert.match(script, /Thread\.Sleep\(slice\)/);
  assert.match(script, /random\.NextDouble\(\)/);
  assert.match(script, /12000\.0 \/ wordsPerMinute/);
  assert.match(script, /::TypeText\(\$text, 37\)/);
  process.child.stdout.write('TYPED');
  process.child.emit('close', 0);
  assert.equal(statuses.at(-1).code, 'TYPED');
  assert.match(statuses.at(-1).message, /37 WPM/);
});

test('typing defaults to 40 WPM and accepts the full selectable range', () => {
  for (const speed of [undefined, MIN_TYPING_WPM, MAX_TYPING_WPM]) {
    const { controller, handlers, typeProcesses } = fixture();
    const result = controller.prepare('reply', 'type', speed);
    const expected = speed ?? DEFAULT_TYPING_WPM;
    assert.equal(result.wordsPerMinute, expected);
    handlers.get(TYPE_SHORTCUT)();
    const script = Buffer.from(typeProcesses[0].args[1].at(-1), 'base64').toString('utf16le');
    assert.ok(script.includes(`::TypeText($text, ${expected})`));
    controller.dispose();
  }
});

test('invalid typing speeds are rejected before copying or arming a shortcut', () => {
  for (const speed of [null, '40', {}, [], NaN, Infinity, 9, 151, 40.5]) {
    const { controller, handlers, clipboard, typeProcesses } = fixture();
    assert.equal(controller.prepare('reply', 'type', speed).ok, false);
    assert.equal(handlers.size, 0);
    assert.equal(clipboard.length, 0);
    assert.equal(typeProcesses.length, 0);
  }
});

test('each prepared reply retains its own speed and invalid settings do not replace a pending reply', () => {
  const { controller, handlers, typeProcesses } = fixture();
  controller.prepare('first reply', 'type', 25);
  assert.equal(controller.prepare('invalid replacement', 'type', 500).ok, false);
  handlers.get(TYPE_SHORTCUT)();
  let script = Buffer.from(typeProcesses[0].args[1].at(-1), 'base64').toString('utf16le');
  assert.ok(script.includes('::TypeText($text, 25)'));
  typeProcesses[0].child.stdout.write('TYPED');
  typeProcesses[0].child.emit('close', 0);
  controller.prepare('second reply', 'type', 120);
  handlers.get(TYPE_SHORTCUT)();
  script = Buffer.from(typeProcesses[1].args[1].at(-1), 'base64').toString('utf16le');
  assert.ok(script.includes('::TypeText($text, 120)'));
  controller.dispose();
});

test('the real Windows helper compiles and runs without emitting any keystrokes', {
  skip: process.platform !== 'win32'
}, () => {
  const { controller, handlers, typeProcesses } = fixture();
  controller.prepare('compile test', 'type');
  handlers.get(TYPE_SHORTCUT)();
  const [executable, args] = typeProcesses[0].args;
  const result = spawnSync(executable, args, {
    input: '',
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'TYPED');
  controller.dispose();
});

test('helper errors are reported once and never mistaken for successful typing', () => {
  const { controller, handlers, typeProcesses, statuses, logs } = fixture();
  controller.prepare('private reply', 'type');
  handlers.get(TYPE_SHORTCUT)();
  const child = typeProcesses[0].child;
  child.stderr.emit('data', 'compiler failure containing private reply');
  child.emit('close', 1);
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].code, 'TYPE_FAILED');
  assert.match(statuses[0].message, /partial text/);
  assert.deepEqual(logs, ['[meeting-helper] TYPE_FAILED']);
  assert.doesNotMatch(JSON.stringify(statuses), /compiler failure|private reply/);
});

test('changing focus or pressing Escape is reported as stopped typing', () => {
  for (const code of [6, 7]) {
    const { controller, handlers, typeProcesses, statuses } = fixture();
    controller.prepare('reply', 'type');
    handlers.get(TYPE_SHORTCUT)();
    typeProcesses[0].child.emit('close', code);
    assert.equal(statuses[0].code, 'TYPE_STOPPED');
  }
});

test('concurrent insertions are rejected and shutdown stops the typing process', () => {
  const { controller, handlers, typeProcesses } = fixture();
  controller.prepare('reply', 'type');
  handlers.get(TYPE_SHORTCUT)();
  assert.equal(controller.prepare('another reply').ok, false);
  controller.dispose();
  assert.equal(typeProcesses[0].child.killed, true);
});

test('cancelling active typing reports cancellation instead of another typing failure', () => {
  const { controller, handlers, typeProcesses, statuses } = fixture();
  controller.prepare('reply', 'type');
  handlers.get(TYPE_SHORTCUT)();
  assert.equal(controller.cancel(), true);
  assert.equal(typeProcesses[0].child.killed, true);
  typeProcesses[0].child.emit('close', null);
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].code, 'CANCELLED');
});

test('process launch failures are reported once even when followed by process close', () => {
  const { controller, handlers, typeProcesses, statuses } = fixture();
  controller.prepare('reply', 'type');
  handlers.get(TYPE_SHORTCUT)();
  typeProcesses[0].child.emit('error', new Error('helper unavailable'));
  typeProcesses[0].child.emit('close', -1);
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].code, 'TYPE_FAILED');
});
