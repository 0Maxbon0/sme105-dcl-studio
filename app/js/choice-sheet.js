import { recordingCompletion } from "./recording.js";
// One accessible, themed picker for every single-select field.
// The original select remains the source of truth for all existing handlers.
const titles = {
  'saved-recordings':'Saved recordings', 'analysis-recording-select':'Recording to analyse',
  'compare-second-recording':'Compare with recording', 'saved-tests':'Saved diagnostic tests',
  'kline-history':'Saved K-Line sessions', 'dashboard-density':'Card size',
  'dashboard-columns':'Dashboard columns', 'live-group':'Sensor group',
  'stored-code-mode':'Stored-code mode', 'transport-select':'Connection transport',
  'theme-mode':'Color theme', 'unit-system':'Display units', 'font-size':'Text size',
  'demo-capture':'Demo capture', 'dcl-command-category':'Command category',
  'dcl-command-firmware':'Firmware compatibility', 'note-ignition':'Ignition',
  'note-engine':'Engine', 'inspector-filter':'Frame filter',
  'compare-reference-pair':'Reference regression pair', 'warning-filter':'Warning severity',
  'warning-sensor-filter':'Sensor', 'live-set':'Data set'
};
const libraryIds = new Set(['saved-recordings','analysis-recording-select','compare-second-recording','saved-tests','kline-history']);
const names = {ALL:'All live readings',LIVE:'Engine readings',LIVE2:'Idle & switches',LIVE3:'Air & spark',KOEO:'Engine-off self-test',KOER:'Engine-running self-test','0E':'Stored fault codes · 0E',A4:'Stored fault codes · A4'};
const readable = value => String(value || 'Unknown').replaceAll('_',' ');
const stamp = value => { const n = typeof value === 'number' ? value : Date.parse(value); return Number.isFinite(n) && n>0 ? new Date(n) : null; };
const formatDate = date => date ? date.toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'}) : 'Date unavailable';
const formatTime = date => date ? date.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'}) : '';
export function describeRecordingOption(option, item, extra = '', {review = false} = {}) {
  const d = stamp(item.started || item.completedAt || item.startedAt || item.id);
  const variant = item.variant || item.source || 'Recording';
  const duration = item.duration ?? (item.ended && item.started ? (item.ended-item.started)/1000 : null);
  const seconds = Number(duration);
  const length = duration != null && Number.isFinite(seconds) && seconds>=0 ? (seconds>=60 ? Math.floor(seconds/60)+'m '+Math.floor(seconds%60)+'s' : seconds.toFixed(1)+'s') : '';
  option.dataset.choiceTitle = names[variant] || readable(variant);
  option.dataset.choiceCode = variant;
  option.dataset.choiceDate = d ? formatDate(d) : 'Date unavailable';
  option.dataset.choiceTime = formatTime(d);
  option.dataset.choiceStatus = item.verdict?.status || item.status || 'Unfinished';
  option.dataset.choiceTone = item.verdict?.valid === true ? 'success' : item.verdict?.valid === false ? 'warning' : 'neutral';
  option.dataset.choiceMeta = [length,item.sampleCount != null ? item.sampleCount+' samples' : '',extra].filter(Boolean).join(' · ');
  if(item.sampleCount != null) option.dataset.choiceSamples=String(item.sampleCount);
  if(review) {
    option.dataset.choiceStatus=recordingCompletion(item);
    option.dataset.choiceTone=option.dataset.choiceStatus==='Complete'?'success':'neutral';
    if(item.manualComplete && !item.verdict?.valid) option.dataset.choiceMeta += ' · Marked by you';
  }
}
export function initChoiceSheets(doc = document) {
  const win = doc.defaultView;
  const fields = new Map();
  const dialog = doc.createElement('dialog');
  dialog.className = 'choice-sheet';
  dialog.setAttribute('aria-labelledby','choice-sheet-title');
  dialog.innerHTML = '<div class="choice-sheet-head"><div><p class="choice-kicker">ESCORTSCOPE / SELECT</p><h2 id="choice-sheet-title"></h2><p class="choice-sheet-subtitle"></p></div><button type="button" class="choice-close" aria-label="Close selection">×</button></div><div class="choice-search-wrap" hidden><label class="choice-search-label" for="choice-search">Search</label><input id="choice-search" type="search" placeholder="Search recordings…" autocomplete="off"></div><div class="choice-filters" role="group" aria-label="Filter recordings" hidden><button type="button" data-filter="all" aria-pressed="true">All</button><button type="button" data-filter="readings" aria-pressed="false">With readings</button><button type="button" data-filter="valid" aria-pressed="false">Valid</button><button type="button" data-filter="unverified" aria-pressed="false">Unverified</button><button type="button" data-filter="complete" aria-pressed="false" hidden>Complete</button><button type="button" data-filter="incomplete" aria-pressed="false" hidden>Incomplete</button></div><div class="choice-list" role="group" aria-labelledby="choice-sheet-title"></div><div class="choice-sheet-foot"><span class="choice-count" role="status"></span><button type="button" class="choice-cancel">Cancel</button></div>';
  doc.body.append(dialog);
  const title = dialog.querySelector('h2'), subtitle = dialog.querySelector('.choice-sheet-subtitle'), search = dialog.querySelector('input'), searchWrap = dialog.querySelector('.choice-search-wrap'), list = dialog.querySelector('.choice-list'), count = dialog.querySelector('.choice-count');
  const filters=dialog.querySelector('.choice-filters');
  let current = null, signature = '', filter = 'all';
  const el = (tag, className, text) => { const n = doc.createElement(tag); if(className)n.className=className; if(text!=null)n.textContent=text; return n; };
  function labelOf(select) {
    return fields.get(select)?.label || titles[select.id] || select.getAttribute('aria-label') || select.labels?.[0]?.textContent.trim() || 'Choose an option';
  }
  function summary(option) {
    if (!option) return ['No options available',''];
    const d=option.dataset;
    return [d.choiceTitle || option.textContent.trim(), [d.choiceDate,d.choiceTime, d.choiceStatus && readable(d.choiceStatus)].filter(Boolean).join(' · ')];
  }
  function refresh(field) {
    const {select,button,main,detail}=field;
    const [label,meta]=summary(select.selectedOptions[0]);
    if(main.textContent!==label) main.textContent=label;
    if(detail.textContent!==meta) detail.textContent=meta;
    detail.hidden=!meta;
    button.disabled=select.disabled || !select.options.length;
    button.setAttribute('aria-label',labelOf(select)+': '+label);
    if(current===field) {
      if(button.disabled) { close(); return; }
      const next=JSON.stringify([select.value,[...select.options].map(o=>[o.value,o.textContent,o.disabled,o.hidden,o.parentElement?.disabled,o.dataset.choiceTitle,o.dataset.choiceStatus,o.dataset.choiceMeta,o.dataset.choiceDate,o.dataset.choiceTime,o.dataset.choiceSamples,o.dataset.choiceTone])]);
      if(next!==signature){signature=next;paint();}
    }
  }
  function close() {
    if(!current)return;
    const button=current.button;
    current=null;signature='';
    if(typeof dialog.close==='function'&&dialog.open)dialog.close(); else dialog.removeAttribute('open');
    doc.body.classList.remove('choice-sheet-open');
    button.setAttribute('aria-expanded','false');
    if(!button.disabled && button.isConnected)button.focus({preventScroll:true});
  }
  function paint() {
    if(!current)return;
    const select=current.select, query=search.value.trim().toLocaleLowerCase();
    const options=[...select.options].filter(o=>!o.hidden && !o.parentElement?.hidden);
    const visible=options.filter(o=>{
      const d=o.dataset;
      const matches=filter==='all'||(filter==='readings'&&Number(d.choiceSamples)>0)||(filter==='valid'&&d.choiceTone==='success')||(filter==='unverified'&&d.choiceTone==='warning')||(filter==='complete'&&d.choiceStatus==='Complete')||(filter==='incomplete'&&d.choiceStatus==='Incomplete');
      return matches&&[o.textContent,...Object.values(d)].join(' ').toLocaleLowerCase().includes(query);
    });
    const fragment=doc.createDocumentFragment();
    let group='';
    for(const o of visible){
      const d=o.dataset;
      if(d.choiceDate && d.choiceDate!==group){group=d.choiceDate;fragment.append(el('h3','choice-date',group));}
      const row=el('button','choice-option');row.type='button';row.dataset.choiceValue=o.value;row.disabled=o.disabled||!!o.parentElement?.disabled;
      row.setAttribute('aria-pressed',String(o===select.selectedOptions[0]));
      const info=el('span','choice-option-info'), headline=el('span','choice-option-heading');
      headline.append(el('span','choice-option-title',d.choiceTitle||o.textContent.trim()));
      if(d.choiceCode && d.choiceCode!==d.choiceTitle)headline.append(el('span','choice-code',d.choiceCode));
      info.append(headline);
      if(d.choiceTime||d.choiceMeta)info.append(el('span','choice-option-meta',[d.choiceTime,d.choiceMeta].filter(Boolean).join(' · ')));
      if(d.choiceStatus){const badge=el('span','choice-status',readable(d.choiceStatus));badge.dataset.tone=d.choiceTone||'neutral';info.append(badge);}
      row.append(info,el('span','choice-tick',o===select.selectedOptions[0]?'✓':''));
      row.addEventListener('click',()=>{
        if(!current || current.select!==select || select.disabled || o.disabled || o.parentElement?.disabled || ![...select.options].includes(o))return;
        select.selectedIndex=o.index;
        close();
        // Re-selecting the current recording must open it too.
        select.dispatchEvent(new win.Event('input',{bubbles:true}));
        select.dispatchEvent(new win.Event('change',{bubbles:true}));
        refresh(fields.get(select));
      });
      fragment.append(row);
    }
    if(!visible.length)fragment.append(el('p','choice-empty',query||filter!=='all'?'No matching entries.':'No entries available.'));
    list.replaceChildren(fragment);
    count.textContent=visible.length+' of '+options.length+' options';
  }
  function open(field) {
    if(field.select.disabled || !field.select.options.length)return;
    if(current)close();
    current=field;search.value='';signature='';filter='all';
    for(const b of filters.querySelectorAll('button'))b.setAttribute('aria-pressed',String(b.dataset.filter==='all'));
    const library=libraryIds.has(field.select.id);
    title.textContent=labelOf(field.select);
    const review=field.select.id==='saved-recordings';
    subtitle.textContent=review?'Recordings with saved readings only. Completion is independent of diagnostic validity.':library?'Choose a saved item. Dates, status and details are kept separate.':'Choose one option.';
    for(const b of filters.querySelectorAll('button')) b.hidden=review?['readings','valid','unverified'].includes(b.dataset.filter):['complete','incomplete'].includes(b.dataset.filter);
    searchWrap.hidden=!library&&field.select.options.length<10;
    filters.hidden=!['saved-recordings','analysis-recording-select','compare-second-recording'].includes(field.select.id);
    search.placeholder=library?'Search date, type or status…':'Search options…';
    field.button.setAttribute('aria-expanded','true');
    doc.body.classList.add('choice-sheet-open');
    if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','');
    refresh(field);list.scrollTop=0;
    dialog.querySelector('.choice-close').focus({preventScroll:true});
  }
  for(const select of doc.querySelectorAll('select:not([multiple])')){
    // The live dataset already has its own segmented control.
    if(select.id==='live-set')continue;
    const fieldLabel=labelOf(select);
    const button=el('button','choice-trigger');button.type='button';button.id='choice-for-'+select.id;
    button.setAttribute('aria-haspopup','dialog');button.setAttribute('aria-expanded','false');
    button.setAttribute('aria-label',labelOf(select));
    const text=el('span','choice-trigger-text'), main=el('span','choice-trigger-main'), detail=el('span','choice-trigger-meta');
    text.append(main,detail);button.append(text,el('span','choice-chevron'));
    const labels=[...(select.labels || [])];
    select.insertAdjacentElement('afterend',button);
    for(const label of labels)label.htmlFor=button.id;
    select.classList.add('choice-native');select.tabIndex=-1;select.setAttribute('aria-hidden','true');
    const field={select,button,main,detail,label:fieldLabel};fields.set(select,field);
    button.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();open(field);});
    select.addEventListener('change',()=>refresh(field));
    new win.MutationObserver(()=>refresh(field)).observe(select,{attributes:true,childList:true,subtree:true,characterData:true});
    refresh(field);
  }
  dialog.querySelector('.choice-close').addEventListener('click',close);
  dialog.querySelector('.choice-cancel').addEventListener('click',close);
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  dialog.addEventListener('click',event=>{if(event.target===dialog)close();});
  search.addEventListener('input',paint);
  filters.addEventListener('click',event=>{const b=event.target.closest('button[data-filter]');if(!b)return;filter=b.dataset.filter;for(const n of filters.querySelectorAll('button'))n.setAttribute('aria-pressed',String(n===b));paint();list.scrollTop=0;});
  return {sync(){for(const field of fields.values())refresh(field);},close};
}
