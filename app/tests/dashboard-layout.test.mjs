import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboardChannels, dashboardSensors, DASHBOARD_DEFAULTS, normalizeDashboardPrefs, reorderedPins, HIDDEN_DASHBOARD_CHANNELS } from '../js/dashboard-layout.js';
import { chartPoints, chartEnvelope, chartBounds, sensorSamplesFromCsv, dashboardSeriesFromCsv } from '../js/chart-series.js';

test('each dashboard uses only its requested channels and permanently omits unsupported manual-car inputs', () => {
  for (const variant of Object.keys(DASHBOARD_DEFAULTS)) {
    const allowed = dashboardChannels(variant);
    assert.ok(allowed.length > 0);
    assert.ok(allowed.every(name => !HIDDEN_DASHBOARD_CHANNELS.has(name)));
    assert.ok(DASHBOARD_DEFAULTS[variant].every(name => allowed.includes(name)), variant);
    assert.deepEqual(dashboardSensors('overview', variant).map(sensor => sensor.name).sort(), [...allowed].sort());
  }
  assert.ok(!dashboardChannels('LIVE').includes('MAF'));
  assert.ok(dashboardChannels('LIVE3').includes('MAF'));
  assert.ok(dashboardChannels('LIVE2').includes('ISCDTY'));
  assert.ok(!dashboardChannels('LIVE2').includes('ECT'));
  assert.notDeepEqual(DASHBOARD_DEFAULTS.LIVE, DASHBOARD_DEFAULTS.ALL);
});

test('custom order, empty dashboards and view survive preference serialization; legacy hidden pins cannot reappear', () => {
  const preferences = normalizeDashboardPrefs({ version: 2, layouts: { ALL: ['MAF','N','ECT','GR_CM','N','missing'], LIVE: [] }, density: 'compact' });
  assert.deepEqual(preferences.layouts.ALL, ['MAF','N','ECT']);
  assert.deepEqual(preferences.layouts.LIVE, []);
  assert.deepEqual(normalizeDashboardPrefs(JSON.parse(JSON.stringify(preferences))), preferences);
  assert.deepEqual(normalizeDashboardPrefs({ pins: ['N','MAP','GR_CM','MAF'] }).layouts.ALL, ['THROTTLE_PERCENT','N','MAF']);
  assert.deepEqual(reorderedPins(preferences.layouts.ALL, 'ECT', 'MAF'), ['ECT','MAF','N']);
  assert.deepEqual(reorderedPins(preferences.layouts.ALL, 'MAF', 'ECT'), ['N','ECT','MAF']);
  assert.deepEqual(normalizeDashboardPrefs(null), normalizeDashboardPrefs());
});

test('charts use ECU timestamps rather than batched receive times and match converted display units', () => {
  const samples = [{ t: 0, receivedAt: 5000, value: 0 }, { t: 1, receivedAt: 5000, value: 100 }];
  assert.deepEqual(chartPoints(samples, 'ECT', 'full', 'imperial'), [{ time: 0, value: 32 }, { time: 1000, value: 212 }]);
  assert.deepEqual(chartPoints([{ t: 1, value: 1 }, { t: 2, value: 1.125 }], 'KAMRF1', 'full').map(point => point.value), [0,12.5]);
  assert.equal(chartPoints([{t:0,value:1},{t:40,value:2}], 'N', '30').length, 1);
});

test('full capture chart retains an isolated spike and includes samples beyond the UI history buffer', async () => {
  const rows = Array.from({length:3000},(_,index)=>`${index/10},N,${index===1599?1000:200},${index===1599?4000:800},rpm,800,rpm`);
  const blob = new Blob(['t_s,pid,raw,value,unit,display_value,display_unit\n'+rows.join('\n')+'\n0,ECT,50,70,C,70,C\n']);
  const samples = await sensorSamplesFromCsv(blob, 'N');
  assert.equal(samples.length, 3000);
  const restored = await dashboardSeriesFromCsv(blob, ['N']);
  assert.equal(restored.N.samples.length, 512);
  assert.equal(restored.N.summary.n, 3000);
  assert.equal(restored.N.summary.max, 4000);
  assert.equal(restored.N.saved, true);
  assert.equal(restored.ECT, undefined);
  const points = chartPoints(samples, 'N', 'full');
  const envelope = chartEnvelope(points, 100);
  assert.ok(envelope.some(point => point.time===159900 && point.value===4000));
  assert.equal(envelope[0].time, 0);
  assert.equal(envelope.at(-1).time, 299900);
});

test('raw-count chart axes use readable ticks without suggesting negative sensor counts', () => {
  assert.deepEqual(chartBounds([{value:1},{value:624}],true),{min:0,max:800,step:200});
  const constant=chartBounds([{value:0},{value:0}],true);
  assert.equal(constant.min,0);assert.ok(constant.max>constant.min);
  const correction=chartBounds([{value:-12.5},{value:6.25}]);
  assert.ok(correction.min<=-12.5 && correction.max>=6.25);
});


test('derived throttle migrates once and remains selectable only in modes requesting actual ITP', () => {
  const old = normalizeDashboardPrefs({layouts:{ALL:['N','ITP']}});
  assert.deepEqual(old.layouts.ALL,['THROTTLE_PERCENT','N','ITP']);
  old.layouts.ALL=old.layouts.ALL.filter(name=>name!=='THROTTLE_PERCENT');
  assert.deepEqual(normalizeDashboardPrefs(JSON.parse(JSON.stringify(old))).layouts.ALL,['N','ITP']);
  for (const variant of ['LIVE','LIVE2','ALL']) {
    assert.ok(dashboardChannels(variant).includes('THROTTLE_PERCENT'));
    assert.ok(dashboardSensors('engine',variant).some(s=>s.name==='THROTTLE_PERCENT' && s.source==='ITP' && s.pid===undefined));
  }
  assert.ok(!dashboardChannels('LIVE3').includes('THROTTLE_PERCENT'));
});


test('dashboard size and columns are reversible persistent preferences, independent of card order', () => {
  const base = {version:2, layouts:{ALL:['ITP','THROTTLE_PERCENT','N']}, density:'compact'};
  for(const density of ['comfortable','small','dense','compact']) for(const columns of ['auto','1','2','3','4']) {
    const prefs=normalizeDashboardPrefs({...base,density,columns});
    assert.equal(prefs.density,density);assert.equal(prefs.columns,columns);
    assert.deepEqual(prefs.layouts.ALL,base.layouts.ALL);
    assert.deepEqual(normalizeDashboardPrefs(JSON.parse(JSON.stringify(prefs))),prefs);
  }
  assert.equal(normalizeDashboardPrefs(base).density,'compact');
  assert.equal(normalizeDashboardPrefs(base).columns,'auto');
  assert.equal(normalizeDashboardPrefs({density:'invalid',columns:20}).density,'comfortable');
  assert.equal(normalizeDashboardPrefs({columns:'invalid'}).columns,'auto');
});
