import test from 'node:test';
import assert from 'node:assert/strict';
import { bitPresentation, renderBitPanel } from '../js/bit-presentation.js';
import { BITMAP_BITS, bitRows, PIDS } from '../js/pids.js';
import { JSDOM } from 'jsdom';

test('published low-byte masks map A/C to bit 3 and AM2 to bit 7, retaining every unknown bit', () => {
  assert.equal(BITMAP_BITS.BITMAP_1[2],undefined);
  assert.equal(BITMAP_BITS.BITMAP_1[6],undefined);
  for (const [name,bits] of Object.entries({BITMAP_0:[6,7,10,11],BITMAP_1:[0,1,3,4,5,7,8]})) {
    for (const bit of bits) {
      const model=bitPresentation(name,1<<bit);
      assert.equal(model.rows.length,12);
      assert.deepEqual(model.rows.filter(row=>row.on).map(row=>row.bit),[bit]);
      assert.match(model.rows[bit].text,/ON.*published reference; vehicle unverified/);
    }
  }
  const unknown=bitPresentation('BITMAP_1',0x44);
  assert.equal(unknown.raw,'Raw word: 0x044');
  assert.match(unknown.rows[2].text,/ON.*Unknown assignment/);
  assert.match(unknown.rows[6].text,/ON.*Unknown assignment/);
  assert.match(unknown.note,/automatic gearbox are not assumed/);
  assert.match(unknown.note,/not a clutch-pedal switch/);
  assert.equal(Object.values(PIDS).some(([name])=>name==='CPP'),false);
});
test('FMEM displays all eight raw bits with set/clear and no invented diagnostic meanings', () => {
  for (const name of ['FMEM_FLAGS','FMEM_FLAG2']) {
    const model=bitPresentation(name,0x81);
    assert.equal(model.raw,'Raw byte: 0x81');
    assert.equal(model.rows.length,8);
    assert.deepEqual(model.rows.filter(row=>row.on).map(row=>row.bit),[0,7]);
    assert.ok(model.rows.every(row=>/Meaning unverified/.test(row.text)));
    assert.match(model.rows[1].text,/CLEAR/);
    assert.match(model.note,/not authenticated DTC/);
    assert.match(bitPresentation(name,0x481).raw,/0x481/);
    assert.equal(bitPresentation(name,0).rows.length,8);
    assert.equal(bitPresentation(name,null).rows.length,0);
  }
  const dom=new JSDOM('<section></section>');const node=dom.window.document.querySelector('section');
  renderBitPanel(node,'BITMAP_1',0x88);
  assert.equal(node.hidden,false);
  assert.match(node.querySelector('[data-bit="3"]').textContent,/ON.*A\/C selected/);
  assert.match(node.querySelector('[data-bit="7"]').textContent,/ON.*Air Management 2/);
  renderBitPanel(node,'FMEM_FLAGS',0);assert.equal(node.querySelectorAll('li').length,8);
  renderBitPanel(node,'ITP',179);assert.equal(node.hidden,true);
  assert.equal(bitRows('FMEM_FLAGS',0).length,8);
  dom.window.close();
});
