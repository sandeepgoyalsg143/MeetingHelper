const MAX_FILE = 2 * 1024 * 1024;
const MAX_TEXT = 24000;

exports.extractResume = async ({ name, data } = {}) => {
  if (typeof name !== 'string' || !Array.isArray(data) || !data.length || data.length > MAX_FILE ||
      data.some(value => !Number.isInteger(value) || value < 0 || value > 255)) {
    throw new Error('Choose a resume file no larger than 2 MiB.');
  }
  const buffer = Buffer.from(data);
  let text;
  if (/\.txt$/i.test(name)) text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  else if (/\.pdf$/i.test(name)) {
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try { text = (await parser.getText({ pageJoiner: '' })).text; }
    finally { await parser.destroy(); }
  } else if (/\.docx$/i.test(name)) {
    text = (await require('mammoth').extractRawText({ buffer })).value;
  } else throw new Error('Supported resume formats: PDF, DOCX and UTF-8 TXT.');
  text = text.trim();
  if (!text) throw new Error('No readable resume text found. For scanned PDFs, upload a text-based PDF, DOCX or TXT instead.');
  if (text.length > MAX_TEXT) throw new Error('Resume exceeds 24,000 characters. Shorten it and upload again.');
  return text;
};
