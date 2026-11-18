import test from 'node:test';
import assert from 'node:assert/strict';
import { Conversation } from '../desktop/conversation.js';

test('only approved, submitted messages enter history after a successful answer', () => {
  const conversation = new Conversation();
  const draftTranscript = 'An editable transcript';
  assert.deepEqual(conversation.history, []);
  const request = conversation.begin(draftTranscript);
  assert.deepEqual(request, [{ role: 'user', text: draftTranscript }]);
  assert.deepEqual(conversation.history, []);
  conversation.complete('An answer');
  assert.deepEqual(conversation.history, [
    { role: 'user', text: draftTranscript }, { role: 'model', text: 'An answer' }
  ]);
});

test('failed requests preserve completed history and retries never duplicate a message', () => {
  const conversation = new Conversation();
  conversation.begin('First');
  conversation.complete('First answer');
  conversation.begin('Second');
  conversation.fail();
  assert.equal(conversation.history.length, 2);
  const retry = conversation.begin('Second');
  assert.equal(retry.length, 3);
  conversation.complete('Second answer');
  assert.equal(conversation.history.length, 4);
});

test('invalid messages and concurrent sends are rejected and clearing removes all history', () => {
  const conversation = new Conversation();
  assert.throws(() => conversation.begin(' '));
  assert.throws(() => conversation.begin('x'.repeat(24001)));
  conversation.begin('Message');
  assert.throws(() => conversation.begin('Duplicate'));
  assert.throws(() => conversation.complete(''));
  conversation.clear();
  assert.deepEqual(conversation.history, []);
  assert.equal(conversation.pending, null);
});
