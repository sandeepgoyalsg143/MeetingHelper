import { Conversation } from './conversation.js';

const $ = id => document.getElementById(id);
const conversation = new Conversation();
let verified = false;
let busy = false;
let capturing = false;
let acquiring = false;
let stopping = false;
let audioWorking = false;
let recordingMode;
let sourceStream;
let recorder;
let clipTimer;
let liveAudioContext;
let liveAudioSource;
let liveAnalyser;
let liveMutedOutput;
let liveSamples;
let liveMonitorTimer;
let liveSpeechDetected = false;
let liveLastVoiceTime;
let liveSilenceStarted = false;
let liveClipStartedAt;
let captureGeneration = 0;
let queue = [];
let retryAction;
let pendingUserNode;
let privacyInfo;
let liveHistory = [];
let lastLiveAnswerTime;
let resumeText = '';
let loadingResume = false;
let liveTrigger = 'silence';
let submitLiveTurn = false;
let screenSource;
let loadingScreens = false;
let remoteMode = false;
let accountDataGeneration = 0;

function navigateToPart(part) {
  if (!Number.isInteger(part) || part < 1 || part > 3) return;
  for (let index = 1; index <= 3; index++) {
    const tab = $(`tab-${index}`);
    const panel = $(`part-${index}`);
    const selected = index === part;
    tab.classList.toggle('active', selected);
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    panel.hidden = !selected;
  }
  document.querySelector('main').scrollTop = 0;
}

function clearAccountData() {
  accountDataGeneration++;
  conversation.clear();
  liveHistory = [];
  queue = [];
  pendingUserNode = undefined;
  resumeText = '';
  screenSource = undefined;
  $('messages').querySelectorAll('.message').forEach(node => node.remove());
  $('empty').hidden = false;
  $('composer').value = '';
  $('transcript').value = '';
  $('resume').value = '';
  $('resume-status').textContent = 'No resume. Replies use generic meeting context.';
  $('live-transcript').textContent = '';
  $('live-answer').textContent = '';
  $('live-panel').hidden = true;
  $('transcript-panel').hidden = true;
  $('include-screen').checked = false;
  updateScreenStatus();
}

function showLogin(message = '') {
  verified = false;
  clearAccountData();
  $('login-panel').hidden = false;
  document.querySelector('.step-nav').hidden = true;
  document.querySelector('main').hidden = true;
  $('sign-out').hidden = true;
  $('login-status').textContent = message;
}

function showApplication(email) {
  $('login-panel').hidden = true;
  document.querySelector('.step-nav').hidden = false;
  document.querySelector('main').hidden = false;
  $('sign-out').hidden = !remoteMode;
  $('sign-out').disabled = busy || capturing || acquiring || stopping || audioWorking;
  if (email) $('login-status').textContent = `Signed in as ${email}.`;
}

for (let part = 1; part <= 3; part++) {
  $(`tab-${part}`).addEventListener('click', () => navigateToPart(part));
}
window.meetingHelper.onNavigateToPart(navigateToPart);
$('show-controls').addEventListener('click', () => void window.meetingHelper.showControls());
$('open-controls-from-overlay').addEventListener('click', () => void window.meetingHelper.showControls());

let captureExcluded = true;
function renderCaptureExclusion(state) {
  captureExcluded = state.captureExcluded;
  $('capture-exclusion-toggle').textContent = captureExcluded
    ? 'Make visible to screen share' : 'Request exclusion from screen share';
  $('capture-exclusion-status').textContent = `${captureExcluded ? 'Capture exclusion requested' : 'Capture exclusion is off; the app may appear in shares'}. ` +
    `${state.captureShortcutRegistered ? 'Ctrl+Alt+V toggles this setting.' : 'Ctrl+Alt+V is unavailable; use this button.'} Not guaranteed in every sharing mode.`;
}

async function setCaptureExclusion(excluded) {
  try {
    const result = await window.meetingHelper.setCaptureExclusion(excluded);
    if (!result.ok) throw new Error(result.error);
    renderCaptureExclusion(result);
  } catch (error) {
    showError(error);
  }
}

$('capture-exclusion-toggle').addEventListener('click', () => void setCaptureExclusion(!captureExcluded));
window.meetingHelper.onCaptureExclusionState(renderCaptureExclusion);

function refresh() {
  const active = capturing || acquiring || stopping || audioWorking || loadingResume;
  const unavailable = !verified || busy || active;
  $('send').disabled = unavailable;
  $('verify').disabled = busy || active;
  $('meeting').disabled = unavailable || !$('consent').checked;
  $('live').disabled = unavailable || !$('consent').checked;
  $('microphone').disabled = unavailable || !$('consent').checked;
  $('stop').disabled = !capturing;
  $('approve').disabled = active || busy || queue.length > 0 || !$('transcript').value.trim();
  $('discard').disabled = active || busy;
  $('new-chat').disabled = busy || active;
  $('retry').disabled = busy || active;
  $('composer').disabled = busy;
  $('consent').disabled = active;
  $('resume').disabled = busy || active || queue.length > 0;
  $('clear-resume').disabled = busy || active || queue.length > 0 || !resumeText;
  $('live-trigger').disabled = busy || active;
  $('send-audio').disabled = !capturing || acquiring || stopping || audioWorking ||
    recordingMode !== 'live' || liveTrigger !== 'manual' || recorder?.state !== 'recording';
  $('choose-screen').disabled = busy || loadingScreens;
  $('stop-screen').hidden = !screenSource;
  $('stop-screen').disabled = busy;
  $('include-screen').disabled = busy || !screenSource;
}

function updateScreenStatus() {
  $('screen-status').textContent = screenSource
    ? `Screen access on: ${screenSource.name}. ${$('include-screen').checked
      ? 'A fresh snapshot is sent with each message.' : 'Snapshots paused; check Include to use it.'}`
    : 'Off. Choose a screen or window to ask questions about what is on it.';
}

function closeScreenPicker() {
  $('screen-sources').hidden = true;
  $('screen-sources').replaceChildren();
}

function selectScreen(source) {
  screenSource = { id: source.id, name: source.name };
  closeScreenPicker();
  $('include-screen').checked = true;
  updateScreenStatus();
  refresh();
}

async function chooseScreen() {
  if (loadingScreens || busy) return;
  if (!$('screen-sources').hidden) { closeScreenPicker(); updateScreenStatus(); return; }
  loadingScreens = true;
  clearError();
  $('screen-status').textContent = 'Loading screens and windows...';
  refresh();
  try {
    const result = await window.meetingHelper.screenSources();
    if (!result.ok) throw new Error(result.error);
    if (!result.sources.length) throw new Error('No capturable screens or windows found. Restore a minimized window and try again.');
    const list = $('screen-sources');
    list.replaceChildren();
    for (const source of result.sources) {
      const button = document.createElement('button');
      button.type = 'button';
      button.title = source.name;
      button.dataset.sourceId = source.id;
      const preview = document.createElement('img');
      preview.alt = '';
      if (source.thumbnail.startsWith('data:image/')) preview.src = source.thumbnail;
      const name = document.createElement('span');
      name.textContent = source.name;
      button.append(preview, name);
      button.addEventListener('click', () => selectScreen(source));
      list.append(button);
    }
    list.hidden = false;
    $('screen-status').textContent = 'Select the screen or window to use. Click Choose again to cancel.';
  } catch (error) {
    showError(error);
    updateScreenStatus();
  } finally { loadingScreens = false; refresh(); }
}

function showError(error, retry) {
  $('error-message').textContent = error.message || 'An unexpected error occurred.';
  $('error').hidden = false;
  retryAction = error.retryable ? retry : undefined;
  $('retry').hidden = !retryAction;
}

function clearError() {
  $('error').hidden = true;
  retryAction = undefined;
}

function updateTypingSpeed() {
  const speed = $('typing-speed').value;
  $('typing-speed-value').textContent = `${speed} WPM`;
  $('typing-speed').setAttribute('aria-valuetext', `${speed} words per minute`);
}

function restoreTypingSpeed() {
  try {
    const saved = localStorage.getItem('typing-speed-wpm');
    if (saved !== null) {
      const speed = Number(saved);
      const input = $('typing-speed');
      if (!Number.isInteger(speed) || speed < Number(input.min) || speed > Number(input.max)) {
        throw new Error('The saved typing speed is invalid. Select a speed again to replace it.');
      }
      input.value = String(speed);
    }
  } catch (error) {
    showError(new Error(`Could not restore the typing speed. Using ${$('typing-speed').defaultValue} WPM for this session. ${error.message}`));
  }
  updateTypingSpeed();
}

async function request(route, body) {
  let response;
  try { response = await window.meetingHelper.request(route, body); }
  catch { throw Object.assign(new Error('Cannot contact the desktop server. Restart the app.'), { retryable: true }); }
  if (!response.ok) {
    if (remoteMode && response.status === 401) {
      if (capturing) stopCapture();
      showLogin('Your session ended or account access was disabled. Sign in again if access is still active.');
    }
    if (['MODEL_UNAVAILABLE', 'MODEL_NOT_VERIFIED', 'AUTH_FAILED', 'SAP_AUTH_FAILED',
      'DEPLOYMENT_MODEL_MISMATCH', 'DEPLOYMENT_NOT_RUNNING'].includes(response.data.code)) {
      verified = false;
      $('connection-status').textContent = 'SAP model access needs verification. No substitute selected.';
    }
    throw Object.assign(new Error(response.data.error), {
      code: response.data.code, retryable: response.data.retryable
    });
  }
  return response.data;
}

function message(role, text) {
  $('empty').hidden = true;
  const node = document.createElement('article');
  node.className = `message ${role}`;
  const title = document.createElement('strong');
  title.textContent = role === 'user' ? 'You' : 'Suggested reply';
  const body = document.createElement('p');
  body.textContent = text;
  node.append(title, body);
  if (role === 'model') {
    const paste = document.createElement('button');
    paste.type = 'button';
    paste.className = 'quiet paste-reply';
    paste.textContent = 'Paste reply into active editor';
    paste.addEventListener('click', () => void preparePaste(text));
    const type = document.createElement('button');
    type.type = 'button';
    type.className = 'quiet paste-reply';
    type.textContent = 'Type reply into active editor';
    type.addEventListener('click', () => void preparePaste(text, 'type'));
    node.append(paste, type);
  }
  $('messages').append(node);
  node.scrollIntoView({ block: 'nearest' });
  return node;
}

async function send() {
  if (!verified || busy || capturing || acquiring || stopping || audioWorking) return;
  const generation = accountDataGeneration;
  const text = $('composer').value.trim();
  let history;
  try { history = conversation.begin(text); }
  catch (error) { showError(error); return; }
  clearError();
  busy = true;
  pendingUserNode = message('user', text);
  pendingUserNode.classList.add('pending');
  $('activity').hidden = false;
  $('activity').textContent = 'Thinking about your conversation...';
  refresh();
  try {
    let screen;
    if (screenSource && $('include-screen').checked) {
      $('activity').textContent = 'Capturing your screen...';
      const shot = await window.meetingHelper.captureScreen(screenSource.id);
      if (generation !== accountDataGeneration) return;
      if (!shot.ok) throw new Error(shot.error);
      screen = { data: shot.data, mimeType: shot.mimeType };
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'Screen attached';
      pendingUserNode.querySelector('strong').append(tag);
      $('activity').textContent = 'Thinking about your conversation and screen...';
    }
    const data = await request('/api/chat', { history, ...(resumeText ? { resume: resumeText } : {}),
      ...(screen ? { screen } : {}) });
    if (generation !== accountDataGeneration) return;
    conversation.complete(data.answer);
    pendingUserNode.classList.remove('pending');
    pendingUserNode = undefined;
    message('model', data.answer);
    $('composer').value = '';
  } catch (error) {
    if (generation !== accountDataGeneration) return;
    conversation.fail();
    pendingUserNode?.remove();
    pendingUserNode = undefined;
    $('empty').hidden = conversation.history.length > 0;
    showError(error, send);
  } finally {
    busy = false;
    $('activity').hidden = true;
    refresh();
  }
}

async function preparePaste(text, mode = 'paste') {
  const wordsPerMinute = Number($('typing-speed').value);
  if (mode === 'type' && !window.confirm(
    'This will simulate typing the full reply into whichever app or text field has focus after Meeting Helper hides. ' +
    `Speed: approximately ${wordsPerMinute} WPM with varied pauses. ` +
    'Focus the intended editor before pressing the shortcut. Avoid typing manually until it finishes; Escape stops it. Continue?')) return;
  clearError();
  $('paste-status').hidden = false;
  $('paste-status').textContent = mode === 'type'
    ? 'Preparing one-time typing...'
    : 'Preparing one-time paste...';
  try {
    const result = mode === 'type'
      ? await window.meetingHelper.prepareType(text, wordsPerMinute)
      : await window.meetingHelper.preparePaste(text);
    if (!result.ok) throw new Error(result.error);
    $('paste-status').textContent = `Ready. Focus the editor where you want the reply, then press ${result.shortcut}. ` +
      (mode === 'type' ? `Typing speed: approximately ${result.wordsPerMinute} WPM. ` : '') +
      'This acts on whichever field is focused and expires in 60 seconds.';
    $('cancel-paste').hidden = false;
  } catch (error) {
    $('paste-status').textContent = error.message || 'Could not prepare the paste.';
    showError(error);
    $('error').scrollIntoView({ block: 'center' });
  }
}

async function verify() {
  if (busy || capturing || acquiring || stopping || audioWorking) return;
  clearError();
  busy = true;
  $('connection-status').textContent = 'Checking SAP OAuth, deployment, text generation and silent WAV input...';
  refresh();
  try {
    const data = await request('/api/verify', {});
    verified = data.textGeneration && data.audioTranscription;
    $('connection-status').textContent = 'SAP AI Core text and audio checks passed. Ready.';
  } catch (error) {
    verified = false;
    $('connection-status').textContent = 'Model access not verified. No substitute selected.';
    showError(error, verify);
  } finally { busy = false; refresh(); }
}

function mediaError(error) {
  const messages = {
    NotAllowedError: 'Audio access was denied or cancelled. Enable microphone access in Windows Settings > Privacy & security > Microphone, then try again.',
    NotFoundError: 'No audio device was found. Connect a microphone or check your Windows sound output.',
    NotReadableError: 'Windows could not read this audio device. Check whether another app has exclusive access.',
    NotSupportedError: 'This audio capture format is not supported on this computer.'
  };
  return Object.assign(new Error(messages[error.name] || error.message || 'Audio capture failed.'), { retryable: false });
}

function stopTracks() {
  sourceStream?.getTracks().forEach(track => track.stop());
  sourceStream = undefined;
}

function stopLiveMonitor() {
  clearInterval(liveMonitorTimer);
  liveMonitorTimer = undefined;
  liveAudioSource?.disconnect();
  liveAudioSource = undefined;
  liveMutedOutput?.disconnect();
  liveMutedOutput = undefined;
  liveAnalyser = undefined;
  liveSamples = undefined;
  if (liveAudioContext && liveAudioContext.state !== 'closed') void liveAudioContext.close();
  liveAudioContext = undefined;
}

async function startLiveMonitor() {
  liveAudioContext = new AudioContext();
  liveAudioSource = liveAudioContext.createMediaStreamSource(new MediaStream(sourceStream.getAudioTracks()));
  liveAnalyser = liveAudioContext.createAnalyser();
  liveAnalyser.fftSize = 2048;
  liveSamples = new Float32Array(liveAnalyser.fftSize);
  liveMutedOutput = liveAudioContext.createGain();
  liveMutedOutput.gain.value = 0;
  liveAudioSource.connect(liveAnalyser);
  liveAnalyser.connect(liveMutedOutput);
  liveMutedOutput.connect(liveAudioContext.destination);
  await liveAudioContext.resume();
  if (liveAudioContext.state !== 'running') throw new Error('Audio activity detection could not start.');
  liveMonitorTimer = setInterval(() => {
    if (!capturing || recordingMode !== 'live' || !liveAnalyser || !liveSamples) return;
    liveAnalyser.getFloatTimeDomainData(liveSamples);
    const rms = Math.sqrt(liveSamples.reduce((sum, sample) => sum + sample * sample, 0) / liveSamples.length);
    const now = performance.now();
    if (rms >= 0.015) {
      liveSpeechDetected = true;
      liveLastVoiceTime = now;
      if (liveSilenceStarted) $('live-status').textContent = 'Audio resumed. Waiting for 2 seconds of silence before replying.';
      else if (!$('live-status').textContent.startsWith('Speech detected')) {
        $('live-status').textContent = 'Speech detected. Waiting for 2 seconds of silence before replying.';
      }
      liveSilenceStarted = false;
    } else if (liveSpeechDetected && liveLastVoiceTime !== undefined) {
      const silenceMs = now - liveLastVoiceTime;
      if (!liveSilenceStarted) {
        liveSilenceStarted = true;
        $('live-status').textContent = 'Silence detected. Waiting 2 seconds before generating a reply.';
      }
      if (liveTrigger === 'silence' && silenceMs >= 2000 && recorder?.state === 'recording') {
        $('live-status').textContent = '2 seconds of silence reached. Generating a reply...';
        recorder.stop();
      }
    } else if (recorder?.state === 'recording' && now - liveClipStartedAt >= 10000) {
      // Recycle idle recorders so prolonged meeting silence does not accumulate in memory.
      recorder.stop();
    }
  }, 100);
}

function stopCapture() {
  capturing = false;
  clearTimeout(clipTimer);
  if (recordingMode === 'live') stopLiveMonitor();
  if (recorder?.state === 'recording') { stopping = true; recorder.stop(); }
  else stopTracks();
  $('audio-status').textContent = 'Stopped. Finishing queued transcriptions...';
  refresh();
}

async function toBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

async function drainQueue() {
  if (audioWorking || !queue.length) return;
  audioWorking = true;
  refresh();
  while (queue.length) {
    const clip = queue[0];
    try {
      const live = recordingMode === 'live';
      if (live) $('live-status').textContent = `Processing audio; ${queue.length} clip(s) pending...`;
      const started = performance.now();
      const data = await request(live ? '/api/live' : '/api/transcribe', {
        data: await toBase64(clip),
        mimeType: clip.type.split(';')[0],
        ...(live ? { history: liveHistory, ...(resumeText ? { resume: resumeText } : {}) } : {})
      });
      if (live) {
        if (data.transcript) {
          $('live-transcript').textContent = data.transcript;
          liveHistory.push({ role: 'user', text: data.transcript },
            { role: 'model', text: data.answer || 'No reply suggested for this segment.' });
          while (liveHistory.length > 12 || liveHistory.reduce((size, item) => size + item.text.length, 0) > 12000) {
            liveHistory.splice(0, 2);
          }
        }
        if (data.answer) {
          $('live-answer').textContent = data.answer;
          $('paste-live-answer').disabled = false;
          $('type-live-answer').disabled = false;
          lastLiveAnswerTime = new Date().toLocaleTimeString();
        }
        $('live-status').textContent = `${data.transcript ? 'Speech processed' : 'No intelligible speech'} in ` +
          `${((performance.now() - started) / 1000).toFixed(1)}s after capture. ` +
          (data.answer ? `New suggestion at ${lastLiveAnswerTime}.` :
            `No new suggestion.${lastLiveAnswerTime ? ` Last reply: ${lastLiveAnswerTime}.` : ''}`);
      } else {
        if ($('transcript').value.length + data.transcript.length + 2 > 24000) {
          throw new Error('Transcript limit reached. Stop, approve or copy the existing text, then record again.');
        }
        $('transcript').value += ($('transcript').value ? '\n\n' : '') + data.transcript;
      }
      queue.shift();
    } catch (error) {
      if (error.code === 'NO_SPEECH') {
        queue.shift();
        $('audio-status').textContent = error.message;
        if (!capturing && !queue.length) showError(error);
        continue;
      }
      stopCapture();
      showError(error, async () => { clearError(); await drainQueue(); });
      break;
    }
  }
  audioWorking = false;
  if (!capturing && !queue.length) $('audio-status').textContent = recordingMode === 'live'
    ? 'Live capture stopped. All recorded clips processed.' : 'Ready to review. Edit the transcript, approve it, then send your message.';
  else if (capturing) $('audio-status').textContent = `Recording ${recordingMode === 'voice' ? 'microphone' : 'computer audio'}${recordingMode === 'live' ? ' for automatic live suggestions' : ''}; ${queue.length} clip(s) waiting.`;
  refresh();
}

function recordClip(generation) {
  const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
    .find(type => MediaRecorder.isTypeSupported(type));
  if (!mimeType) throw new DOMException('No supported recording format.', 'NotSupportedError');
  const chunks = [];
  let clipBytes = 0;
  let oversized = false;
  const current = new MediaRecorder(new MediaStream(sourceStream.getAudioTracks()), {
    mimeType, audioBitsPerSecond: 64000
  });
  recorder = current;
  current.ondataavailable = event => {
    clipBytes += event.data.size;
    if (clipBytes > 6 * 1024 * 1024) {
      oversized = true;
      chunks.length = 0;
      stopCapture();
      showError(new Error('Audio turn exceeded 6 MiB and was discarded. Start again and send a shorter turn.'));
    } else if (event.data.size && !oversized) chunks.push(event.data);
  };
  current.onerror = () => {
    stopCapture();
    showError(new Error('Audio recorder failed. Review any existing transcript and try recording again.'));
  };
  current.onstop = () => {
    stopping = false;
    clearTimeout(clipTimer);
    const clip = new Blob(chunks, { type: mimeType });
    if (!oversized && clip.size && (recordingMode !== 'live' ||
        (liveTrigger === 'manual' ? submitLiveTurn : liveSpeechDetected))) queue.push(clip);
    submitLiveTurn = false;
    if (recordingMode === 'live') {
      liveSpeechDetected = false;
      liveLastVoiceTime = undefined;
      liveSilenceStarted = false;
    }
    if (queue.length >= 3 && capturing) {
      capturing = false;
      if (recordingMode === 'live') stopLiveMonitor();
      showError(new Error('Transcription is falling behind. Recording stopped to prevent unbounded audio buffering. Review the pending clips.'));
    }
    if (capturing && generation === captureGeneration) {
      try { recordClip(generation); }
      catch (error) {
        capturing = false;
        if (recordingMode === 'live') stopLiveMonitor();
        stopTracks();
        showError(mediaError(error));
      }
    } else stopTracks();
    void drainQueue();
    refresh();
  };
  if (recordingMode === 'live') current.start(1000);
  else current.start();
  refresh();
  liveClipStartedAt = performance.now();
  const finishClip = () => {
    if (recordingMode === 'voice') stopCapture();
    else if (current.state === 'recording') current.stop();
  };
  if (recordingMode !== 'live') {
    clipTimer = setTimeout(finishClip, recordingMode === 'meeting' ? 12000 : 30000);
  }
}

async function startCapture(mode) {
  if (!verified || busy || audioWorking || capturing || acquiring || stopping || !$('consent').checked) return;
  if (queue.length) {
    showError(new Error('Retry the pending transcription or discard it before starting another recording.'));
    return;
  }
  if ((mode === 'meeting' || mode === 'live') && !window.confirm(
    'This records ALL computer output, including Teams/Zoom, notifications, and other apps. ' +
    (mode === 'live' ? 'LIVE MODE sends audio automatically through SAP AI Core to Gemini for transcription AND suggested answers, without approval. ' :
      'Clips are sent through SAP AI Core to the Gemini provider for transcription. ') +
    'Screen video is discarded locally. Continue?')) return;
  clearError();
  recordingMode = mode;
  liveTrigger = document.querySelector('input[name="live-trigger"]:checked')?.value || 'silence';
  submitLiveTurn = false;
  capturing = true;
  acquiring = true;
  refresh();
  try {
    sourceStream = mode !== 'voice'
      ? await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
      : await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    if (!sourceStream.getAudioTracks().some(track => track.readyState === 'live')) {
      throw new Error('No live audio track available. Check the output device or microphone and try again.');
    }
    // Display capture requires a video track; it is never recorded or sent to SAP AI Core.
    sourceStream.getVideoTracks().forEach(track => track.stop());
    sourceStream.getAudioTracks().forEach(track => {
      track.onended = () => { if (capturing) { stopCapture(); showError(new Error('Audio device disconnected or capture permission was revoked.')); } };
    });
    if (!capturing) { stopTracks(); return; }
    if (mode === 'live') {
      liveHistory = [];
      lastLiveAnswerTime = undefined;
      $('live-panel').hidden = false;
      $('live-transcript').textContent = '';
      $('live-answer').textContent = 'Waiting for a question...';
      $('paste-live-answer').disabled = true;
      $('type-live-answer').disabled = true;
      $('live-status').textContent = liveTrigger === 'manual'
        ? 'Listening locally. Click Send audio when ready. Stop discards unsent audio.'
        : 'Listening. Replies are generated after 2 seconds of silence.';
      if (liveTrigger === 'silence') await startLiveMonitor();
    } else {
      $('live-panel').hidden = true;
      $('transcript-panel').hidden = false;
    }
    navigateToPart(3);
    $('audio-status').textContent = mode === 'live'
      ? liveTrigger === 'manual' ? 'LIVE: listening until you click Send audio. Stop discards unsent audio.'
        : 'LIVE: listening for speech and replying after 2 seconds of silence. Stop to end capture.'
      : mode === 'meeting'
      ? 'Recording computer audio in 12-second clips. Stop to review before sending.'
      : 'Recording microphone. Click Stop when finished (30-second maximum).';
    recordClip(++captureGeneration);
  } catch (error) {
    capturing = false;
    if (mode === 'live') stopLiveMonitor();
    stopTracks();
    showError(mediaError(error));
  } finally { acquiring = false; refresh(); }
}

$('chat-form').addEventListener('submit', event => { event.preventDefault(); void send(); });
$('composer').addEventListener('keydown', event => {
  if (event.ctrlKey && event.key === 'Enter') { event.preventDefault(); void send(); }
});
$('verify').addEventListener('click', () => void verify());
$('retry').addEventListener('click', () => { if (retryAction) void retryAction(); });
$('meeting').addEventListener('click', () => void startCapture('meeting'));
$('live').addEventListener('click', () => void startCapture('live'));
$('microphone').addEventListener('click', () => void startCapture('voice'));
$('stop').addEventListener('click', stopCapture);
$('send-audio').addEventListener('click', () => {
  if ($('send-audio').disabled) return;
  submitLiveTurn = true;
  stopping = true;
  recorder.stop();
  refresh();
});
$('paste-live-answer').addEventListener('click', () => void preparePaste($('live-answer').textContent));
$('type-live-answer').addEventListener('click', () => void preparePaste($('live-answer').textContent, 'type'));
$('cancel-paste').addEventListener('click', () => void window.meetingHelper.cancelPaste());
$('resume').addEventListener('change', async () => {
  const file = $('resume').files[0];
  if (!file) return;
  loadingResume = true;
  clearError();
  refresh();
  try {
    if (file.size > 2 * 1024 * 1024) throw new Error('Resume must be no larger than 2 MiB.');
    const result = await window.meetingHelper.readResume({ name: file.name,
      data: Array.from(new Uint8Array(await file.arrayBuffer())) });
    if (!result.ok) throw new Error(result.error);
    resumeText = result.text;
    $('resume-status').textContent = `Resume active: ${file.name}. First-person replies enabled.`;
  } catch (error) { showError(error); }
  finally { $('resume').value = ''; loadingResume = false; refresh(); }
});
$('clear-resume').addEventListener('click', () => {
  resumeText = '';
  $('resume').value = '';
  $('resume-status').textContent = 'No resume. Replies use generic meeting context. Start New chat to remove old persona replies.';
  refresh();
});
$('consent').addEventListener('change', refresh);
$('transcript').addEventListener('input', refresh);
$('approve').addEventListener('click', () => {
  const text = $('transcript').value.trim();
  const combined = [$('composer').value.trim(), text].filter(Boolean).join('\n\n');
  if (combined.length > 24000) { showError(new Error('Message limit is 24000 characters. Shorten the transcript or message first.')); return; }
  $('composer').value = combined;
  $('transcript').value = '';
  $('transcript-panel').hidden = true;
  $('composer').focus();
  refresh();
});
$('discard').addEventListener('click', () => {
  if (!window.confirm('Discard the transcript and any pending audio clips?')) return;
  queue = [];
  $('transcript').value = '';
  $('transcript-panel').hidden = true;
  clearError();
  refresh();
});
$('new-chat').addEventListener('click', () => {
  if (!window.confirm('Clear this conversation, drafts, transcript and pending audio? This cannot be undone.')) return;
  conversation.clear();
  liveHistory = [];
  lastLiveAnswerTime = undefined;
  $('live-panel').hidden = true;
  $('live-transcript').textContent = '';
  $('live-answer').textContent = '';
  $('paste-live-answer').disabled = true;
  $('type-live-answer').disabled = true;
  queue = [];
  $('messages').querySelectorAll('.message').forEach(node => node.remove());
  $('empty').hidden = false;
  $('composer').value = '';
  $('transcript').value = '';
  $('transcript-panel').hidden = true;
  clearError();
  refresh();
});
document.querySelectorAll('[data-prompt]').forEach(button => button.addEventListener('click', () => {
  if (busy) return;
  $('composer').value = button.dataset.prompt;
  $('composer').focus();
  if (button.hasAttribute('data-screen')) {
    if (screenSource) { $('include-screen').checked = true; updateScreenStatus(); }
    else void chooseScreen();
  }
}));
$('choose-screen').addEventListener('click', () => void chooseScreen());
$('stop-screen').addEventListener('click', () => {
  screenSource = undefined;
  $('include-screen').checked = false;
  closeScreenPicker();
  updateScreenStatus();
  refresh();
});
$('include-screen').addEventListener('change', updateScreenStatus);
let ghostEnabled = false;
function renderOverlay(state) {
  ghostEnabled = state.ghost;
  $('ghost-mode').textContent = state.ghost ? 'Ghost mode on - clicks pass through' : 'Enable ghost mode';
  $('ghost-mode').setAttribute('aria-pressed', String(state.ghost));
  $('ghost-opacity').value = String(state.ghostOpacity);
  $('ghost-opacity-value').textContent = `${state.ghostOpacity}%`;
  $('ghost-status').textContent = (state.ghost
    ? 'Work in the app underneath; this overlay does not accept clicks. '
    : 'Ghost mode passes clicks to the app underneath. ') +
    (state.ghostShortcutRegistered ? 'Ctrl+Alt+G toggles ghost mode. ' : 'Ctrl+Alt+G is unavailable. ') +
    'Use Quick Controls to navigate or toggle ghost mode while the main window is click-through.';
  if ('captureExcluded' in state) renderCaptureExclusion(state);
}
async function setOverlay(enabled) {
  try {
    const result = await window.meetingHelper.setOverlay(enabled, Number($('ghost-opacity').value));
    if (!result.ok) throw new Error(result.error);
    renderOverlay(result);
  } catch (error) {
    showError(error);
    $('error').scrollIntoView({ block: 'center' });
  }
}
$('ghost-mode').addEventListener('click', () => void setOverlay(!ghostEnabled));
$('ghost-opacity').addEventListener('input', () => {
  $('ghost-opacity-value').textContent = `${$('ghost-opacity').value}%`;
});
$('ghost-opacity').addEventListener('change', () => void setOverlay(ghostEnabled));
window.meetingHelper.onOverlayState(renderOverlay);
$('typing-speed').addEventListener('input', updateTypingSpeed);
$('typing-speed').addEventListener('change', () => {
  updateTypingSpeed();
  try {
    localStorage.setItem('typing-speed-wpm', $('typing-speed').value);
  } catch (error) {
    showError(new Error(`Could not save the typing speed. Your selection still works for this session. ${error.message}`));
    $('error').scrollIntoView({ block: 'center' });
  }
});
window.meetingHelper.onPasteStatus(status => {
  $('paste-status').hidden = false;
  $('paste-status').textContent = status.message;
  $('cancel-paste').hidden = true;
  if (!status.ok && ['TYPE_FAILED', 'TYPE_STOPPED', 'PASTE_FAILED'].includes(status.code)) {
    showError(new Error(status.message));
    $('error').scrollIntoView({ block: 'center' });
  }
});
window.addEventListener('beforeunload', () => {
  capturing = false;
  clearTimeout(clipTimer);
  stopLiveMonitor();
  stopTracks();
  queue = [];
});

restoreTypingSpeed();
async function initializeService() {
  try {
    const status = await request('/api/status');
    privacyInfo = await window.meetingHelper.windowInfo();
    if ('ghost' in privacyInfo) renderOverlay(privacyInfo);
    renderCaptureExclusion(privacyInfo);
    $('model').textContent = status.model;
    verified = status.verified;
    $('connection-status').textContent = status.configured
      ? 'Verify service access before recording.'
      : 'The AI service is not configured. Contact the administrator.';
    if (!privacyInfo.alwaysOnTop) showError(new Error('The window is not always on top. Restart the app.'));
  } catch (error) { showError(error); }
  refresh();
}

$('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!remoteMode) return;
  if (busy || capturing || acquiring || stopping || audioWorking) {
    $('login-status').textContent = 'Wait for the current operation to finish, then sign in again.';
    return;
  }
  $('login-submit').disabled = true;
  $('login-status').textContent = 'Signing in...';
  try {
    const result = await window.meetingHelper.authLogin({
      email: $('login-email').value.trim(),
      password: $('login-password').value
    });
    if (!result.ok) {
      $('login-status').textContent = result.error;
      return;
    }
    $('login-password').value = '';
    showApplication(result.email);
    await initializeService();
  } catch {
    $('login-status').textContent = 'Could not contact the sign-in service. Check your connection and try again.';
  } finally { $('login-submit').disabled = false; }
});

$('sign-out').addEventListener('click', async () => {
  if (capturing) stopCapture();
  const result = await window.meetingHelper.authLogout();
  clearError();
  showLogin(result.revoked ? '' : 'Signed out on this device; the service could not confirm server-side session revocation.');
  refresh();
});

try {
  remoteMode = await window.meetingHelper.authMode();
  if (remoteMode) showLogin();
  else {
    showApplication();
    await initializeService();
  }
} catch (error) { showError(error); }
refresh();
