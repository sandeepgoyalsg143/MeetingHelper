export class Conversation {
  history = [];
  pending = null;

  begin(text) {
    if (this.pending !== null) throw new Error('An answer is already pending.');
    if (!text.trim()) throw new Error('Enter a message.');
    if (this.history.length >= 78) throw new Error('This conversation is full. Start a new chat.');
    if (text.length > 24000 || this.history.reduce((size, item) => size + item.text.length, 0) + text.length > 160000) {
      throw new Error('This message or conversation is too long. Shorten it or start a new chat.');
    }
    this.pending = text;
    return [...this.history, { role: 'user', text }];
  }

  complete(answer) {
    if (this.pending === null || typeof answer !== 'string' || !answer.trim()) throw new Error('No complete answer received.');
    this.history.push({ role: 'user', text: this.pending }, { role: 'model', text: answer });
    this.pending = null;
  }

  fail() { this.pending = null; }
  clear() { this.history = []; this.pending = null; }
}
