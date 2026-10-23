import assert from 'node:assert/strict';
import test from 'node:test';
import { splitLongCells } from './export-cells.ts';

test('long Unicode text reconstructs exactly and never splits a surrogate pair', () => {
  const text = 'a'.repeat(32_699) + '😀' + '中文\n'.repeat(13_000) + '🚀'.repeat(4000);
  assert.ok(text.length > 70_000);
  const input = [{ Answer: text, TaskId: 'T1' }];
  const result = splitLongCells(input)[0];
  const pieces = Object.entries(result).filter(([key]) => key === 'Answer' || key.startsWith('Answer (cont.')).map(([, value]) => value as string);
  assert.equal(pieces.join(''), text);
  for (const piece of pieces) {
    assert.ok(piece.length <= 32_700);
    assert.ok(!/^[\uDC00-\uDFFF]/.test(piece));
    assert.ok(!/[\uD800-\uDBFF]$/.test(piece));
  }
  assert.equal((result.Answer as string).length, 32_699);
  assert.equal(input[0].Answer, text);
  assert.deepEqual(Object.keys(input[0]), ['Answer', 'TaskId']);
});

test('short strings, multiline text and non-string values are unchanged', () => {
  const nested = { ok: true };
  const input = [{ question: 'line one\r\nline two\n第三行', count: 3, empty: '', zero: 0, nullable: null, flag: false, nested }];
  const output = splitLongCells(input);
  assert.deepEqual(output, input);
  assert.notEqual(output, input);
  assert.notEqual(output[0], input[0]);
  assert.equal(output[0].nested, nested);
  assert.deepEqual(splitLongCells([]), []);
});

test('continuations are stable across rows and cannot overwrite existing columns', () => {
  const long = 'z'.repeat(70_000);
  const input = [{ Answer: long, 'Answer (cont. 2)': 'keep me' }, { Answer: long, 'Answer (cont. 2) [2]': 'keep me too' }];
  const output = splitLongCells(input);
  assert.equal(output[0]['Answer (cont. 2)'], 'keep me');
  assert.equal(output[1]['Answer (cont. 2) [2]'], 'keep me too');
  for (const row of output) {
    assert.equal((row.Answer as string) + (row['Answer (cont. 2) [3]'] as string) + (row['Answer (cont. 3)'] as string), long);
  }
  assert.deepEqual(splitLongCells(input), output);
});

test('a string exactly at the safe limit remains in its original column', () => {
  const row = { Answer: 'a'.repeat(32_700) };
  assert.deepEqual(splitLongCells([row]), [row]);
});
