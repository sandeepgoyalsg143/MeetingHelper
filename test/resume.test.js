import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractResume } = require('../desktop/resume.cjs');
const upload = (name, text) => ({ name, data: Array.from(Buffer.from(text)) });

test('resume extracts UTF-8 text without interpreting markup or instructions', async () => {
  assert.equal(await extractResume(upload('resume.TXT', '  Alex: Engineer\n<img>  ')), 'Alex: Engineer\n<img>');
});

test('resume extracts DOCX document text locally', async () => {
  const Zip = createRequire(require.resolve('mammoth'))('jszip');
  const zip = new Zip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:body><w:p><w:r><w:t>Alex: Java engineer.</w:t></w:r></w:p></w:body></w:document>');
  const data = Array.from(await zip.generateAsync({ type: 'nodebuffer' }));
  assert.equal(await extractResume({ name: 'resume.docx', data }), 'Alex: Java engineer.');
});

test('resume extracts text-based PDF locally', async () => {
  const stream = 'BT /F1 12 Tf 72 720 Td (Alex: Java engineer.) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += 'xref\n0 6\n0000000000 65535 f \n' +
    offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  assert.equal(await extractResume(upload('resume.pdf', pdf)), 'Alex: Java engineer.');
});

test('resume rejects invalid input, unsupported formats, oversized and empty text', async () => {
  for (const input of [undefined, {}, upload('resume.exe', 'bad'), upload('resume.txt', ' '),
    upload('resume.txt', 'x'.repeat(24001)), { name: 'resume.txt', data: [256] },
    { name: 'resume.txt', data: new Array(2 * 1024 * 1024 + 1).fill(0) },
    upload('broken.pdf', 'not a pdf'), upload('broken.docx', 'not a zip')]) {
    await assert.rejects(extractResume(input));
  }
});
