import test from 'node:test';
import assert from 'node:assert/strict';
import { savedDiagnosticTests, diagnosticTestReport } from '../js/test-history.js';

test('saved diagnostic history retains incomplete tests and codes, excludes live sessions, and orders by completion', () => {
  const koer = { id: 1, type: 'SESSION_RESULT', detail: { variant: 'KOER', startedAt: 1000, completedAt: 2000,
    codes: [{ code: '172', rawBytes: [114, 225] }, { code: '538' }, { code: '521' }], dtcVerified: false,
    verdict: { status: 'INCOMPLETE', reasons: ['TX_PAD mismatch'] } } };
  const stored = { id: 2, type: 'SESSION_RESULT', detail: { variant: '0E', completedAt: 3000, codes: [], verdict: { status: 'VALID' } } };
  const live = { type: 'SESSION_RESULT', detail: { variant: 'ALL', completedAt: 4000 } };
  assert.deepEqual(savedDiagnosticTests([koer, live, stored]), [stored, koer]);
  const text = diagnosticTestReport(koer);
  for (const code of ['172', '538', '521']) assert.ok(text.includes(code));
  assert.match(text, /INCOMPLETE/);
  assert.match(text, /TX_PAD mismatch/);
  assert.match(text, /ECU DTC verification: not reported/);
  assert.match(text, /1970-01-01T00:00:02.000Z/);
  assert.match(text, /rawBytes/);
  assert.match(diagnosticTestReport(stored), /does not certify/);
});


test('DCL discovery results are retained and exported with source and ECU-attribution caveats', () => {
  const probe = { id: 3, type: 'SESSION_RESULT', detail: {
    variant: 'PIDMAP', startedAt: 4000, completedAt: 5000, codes: [],
    dclProbe: { word: '005E', description: 'Read PID map', source: 'doncreat0r/eeciv · tables.h',
      sourceUrl: 'https://github.com/doncreat0r/eeciv/blob/master/tables.h', responseBytes: 32 },
    verdict: { status: 'VALID', reasons: [] },
  } };
  assert.deepEqual(savedDiagnosticTests([probe]), [probe]);
  const report = diagnosticTestReport(probe);
  assert.match(report, /005E/);
  assert.match(report, /Read PID map/);
  assert.match(report, /doncreat0r\/eeciv/);
  assert.match(report, /32/);
  assert.match(report, /ECU ownership \/ command support: unverified/);
  assert.match(report, /raw RO transcript/);
});
