import test from 'node:test';
import assert from 'node:assert/strict';
import { formatMeasurement, formattedReading, formatReplayTime } from '../js/display-format.js';
import { displayReading, rowsToCsv, PIDS } from '../js/pids.js';
import { chartPoints } from '../js/chart-series.js';

test('central formatting gives both speed channels exactly one decimal without rounding source data', () => {
  for (const name of ['VS','VSBAR']) {
    assert.equal(formattedReading(name, 0).text, '0.0');
    assert.equal(formattedReading(name, 11).text, '17.7');
    assert.equal(formattedReading(name, 381/32).text, '19.2');
    const raw = displayReading(name,381/32);
    assert.equal(formattedReading(name,381/32).value, raw.value);
    assert.equal(raw.value,19.161252);
    assert.equal(formattedReading(name,11,{unitSystem:'imperial'}).text,'11.0');
  }
  const rows = [{t:242.280126,name:'VS',raw:381,value:381/32}];
  assert.match(rowsToCsv(rows), /242\.280126/);
  assert.match(rowsToCsv(rows), /19\.161252/);
  assert.equal(chartPoints(rows,'VS','full')[0].value,19.161252);
  assert.equal(PIDS[0x09][2](179),179);
});
test('unit-aware precision keeps integers concise and justified hundredths only', () => {
  assert.equal(formatMeasurement('ITP',179,'A/D'),'179');
  assert.equal(formattedReading('THROTTLE_PERCENT',871).text,'87');
  assert.equal(formatMeasurement('N',912,'rpm'),'912');
  assert.equal(formatMeasurement('ECT',87.777777,'°C'),'87.8');
  assert.equal(formatMeasurement('ECT',88,'°C'),'88');
  assert.equal(formatMeasurement('VBAT',12.5625,'V'),'12.56');
  assert.equal(formatMeasurement('LAMBSE1',1.01234,'lambda'),'1.01');
  assert.equal(formatMeasurement('KAMRF1',6.25,'% correction'),'6.25');
  assert.equal(formatMeasurement('other',1.123456,'V'),'1.1');
  assert.equal(formatMeasurement('VS',null,'km/h'),'—');
  assert.equal(formatReplayTime(242.280126),'242.3s');
  assert.equal(formatReplayTime(0),'0.0s');
  assert.equal(formatReplayTime(null),'—');
});
