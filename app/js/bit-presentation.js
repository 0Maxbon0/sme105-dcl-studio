/** Published assignments are reference information, not vehicle calibration proof. */
import { bitRows, BITMAP_BITS } from './pids.js';
export const BITMAP_REFERENCE = 'https://github.com/flxkrmr/eec-iv-reader-arduino/wiki/PIDs';
export function bitPresentation(name, raw) {
  const bitmap = !!BITMAP_BITS[name], fmem = ['FMEM_FLAGS', 'FMEM_FLAG2'].includes(name);
  if (!bitmap && !fmem) return null;
  const available = Number.isInteger(raw) && raw >= 0 && raw <= 0xfff;
  const hex = n => `0x${n.toString(16).toUpperCase().padStart(fmem ? 2 : 3, '0')}`;
  return {
    raw: available ? `${fmem ? 'Raw byte' : 'Raw word'}: ${hex(fmem ? raw & 0xff : raw)}${fmem && raw > 255 ? ` · original source word: ${hex(raw)}` : ''}` : 'No sample in the selected capture.',
    note: bitmap
      ? 'Published reference assignments; behavior for this exact vehicle is unverified. Equipment fitment is unverified; optional emissions hardware and an automatic gearbox are not assumed. Neutral/park is not a clutch-pedal switch.'
      : 'Failure Mode Effects Management: per-bit meanings are unverified for this ECU. These bits are not authenticated DTC codes.',
    source: bitmap ? BITMAP_REFERENCE : null,
    rows: available ? bitRows(name, raw).map(bit => ({ ...bit,
      text: `Bit ${bit.bit}: ${bitmap ? (bit.on ? 'ON' : 'OFF') : (bit.on ? 'SET' : 'CLEAR')} · ${bit.label}${bitmap && bit.reference ? ' · published reference; vehicle unverified' : ''}${name === 'BITMAP_1' && bit.bit === 8 ? ' · automatic gearbox reference; not applicable to this manual vehicle' : ''}${bitmap && ((name === 'BITMAP_0' && bit.bit === 10) || (name === 'BITMAP_1' && [5,7].includes(bit.bit))) ? ' · equipment fitment unverified' : ''}` })) : [],
  };
}
export function renderBitPanel(node, name, raw) {
  if (!node) return;
  const model = bitPresentation(name, raw);
  node.hidden = !model;
  if (!model) return;
  const doc = node.ownerDocument;
  const value = doc.createElement('p'); value.className = 'bit-raw'; value.textContent = model.raw;
  const note = doc.createElement('p'); note.className = 'help'; note.textContent = model.note;
  const list = doc.createElement('ul'); list.className = 'bits';
  for (const bit of model.rows) {
    const li = doc.createElement('li'); li.dataset.bit = bit.bit; li.classList.toggle('on', bit.on); li.textContent = bit.text; list.append(li);
  }
  const children = [value, note, list];
  if (model.source) {
    const source = doc.createElement('a'); source.href = model.source; source.textContent = 'Published EEC-IV reference'; source.target = '_blank'; source.rel = 'noopener noreferrer'; children.push(source);
  }
  node.replaceChildren(...children);
}
