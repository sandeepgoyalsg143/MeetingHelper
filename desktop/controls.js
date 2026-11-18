const $ = id => document.getElementById(id);

function render(state) {
  $('mode-state').textContent = state.minimized ? 'Main window minimized' :
    state.maximized ? 'Main window maximized' : 'Main window ready';
  $('ghost-state').textContent = state.ghost ? `Ghost on · ${state.ghostOpacity}%` : 'Ghost off';
  $('ghost-state').classList.toggle('on', state.ghost);
  $('toggle-ghost').textContent = state.ghost ? 'Turn ghost mode off' : 'Enable ghost mode';
  $('toggle-ghost').classList.toggle('on', state.ghost);
  $('toggle-capture-exclusion').textContent = state.captureExcluded
    ? 'Make visible to screen share' : 'Request exclusion from screen share';
  $('toggle-capture-exclusion').classList.toggle('on', !state.captureExcluded);
  $('capture-status').textContent = `${state.captureExcluded ? 'Capture exclusion requested' : 'Capture exclusion off; window may appear in shares'}. ` +
    `${state.captureShortcutRegistered ? 'Ctrl+Alt+V toggles this setting.' : 'Ctrl+Alt+V unavailable; use this button.'} Not guaranteed in every sharing mode.`;
  document.querySelectorAll('[data-action^="part-"]').forEach(button => {
    const index = Number(button.dataset.action.slice(-1)) - 1;
    const shortcut = button.querySelector('kbd');
    shortcut.textContent = `Ctrl+Alt+${index + 1}${state.navigationShortcuts?.[index] ? '' : ' · unavailable'}`;
    button.title = state.navigationShortcuts?.[index]
      ? 'Click or use the displayed shortcut'
      : 'Shortcut unavailable; click to navigate';
  });
  const unavailableNavigation = state.navigationShortcuts?.some(registered => !registered);
  $('shortcut-status').textContent =
    `${state.ghostShortcutRegistered ? 'Ctrl+Alt+G toggles ghost mode.' : 'Ctrl+Alt+G unavailable; use this button.'} ` +
    `${state.restoreShortcutRegistered ? 'Ctrl+Alt+Space restores the main window.' : 'Restore shortcut unavailable; use Show / restore.'}` +
    (unavailableNavigation ? ' Some section shortcuts are unavailable; use these buttons.' : '');
}

document.querySelectorAll('[data-action]').forEach(button => {
  button.addEventListener('click', () => void window.meetingHelperControls.action(button.dataset.action));
});
$('hide').addEventListener('click', () => void window.meetingHelperControls.action('hide-controls'));
window.meetingHelperControls.onState(render);
