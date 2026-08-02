let currentTabs = [];
let activeTabId = null;
const tabOptions = {}; // per-tab settings, mirrors Chrome's print dialog

const el = (id) => document.getElementById(id);

function defaultOptions() {
  return {
    copies: 1,
    color: 'color', // 'color' | 'bw'
    pagesMode: 'all', // 'all' | 'custom'
    pageRangeText: '',
    paperSize: 'A4',
    pagesPerSheet: 1,
    dpi: 0, // 0 = automatic/printer default, otherwise literal 300/600/1200
    scaleMode: 'fit-paper', // 'default' | 'fit-printable' | 'fit-paper' | 'custom'
    scaleCustom: 100,
    duplex: false,
    duplexFlip: 'long' // 'long' | 'short'
  };
}

let currentLang = 'en';

function renderTabs() {
  const list = el('tabs-list');
  list.innerHTML = '';
  for (const tab of currentTabs) {
    const div = document.createElement('div');
    div.className = 'tab' + (tab.active ? ' active' : '');
    const lockIcon = tab.locked ? '<span class="tab-lock">🔒</span>' : '';
    const closeIcon = tab.locked ? '' : '<span class="tab-close">✕</span>';
    div.innerHTML = `<span class="tab-title" title="${tab.title}">${lockIcon}${tab.title} (${tab.pageCount})</span>${closeIcon}`;
    div.querySelector('.tab-title').addEventListener('click', () => api.switchTab(tab.id));
    const closeBtn = div.querySelector('.tab-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        api.closeTab(tab.id);
        delete tabOptions[tab.id];
      });
    }
    div.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showTabContextMenu(e.pageX, e.pageY, tab);
    });
    list.appendChild(div);
  }
  el('total-pages-count').textContent = String(
    currentTabs.reduce((sum, t) => sum + (t.pageCount || 0), 0)
  );
  el('empty-state').classList.toggle('hidden', currentTabs.length > 0);
  el('dropzone-hint').style.display = currentTabs.length > 0 ? 'none' : 'block';
}

function showTabContextMenu(x, y, tab) {
  const menu = el('tab-context-menu');
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.classList.remove('hidden');

  // Update dynamic labels
  const dict = TRANSLATIONS[currentLang] || TRANSLATIONS.en;
  const pinLabel = tab.pinned ? (dict.unpinTab || 'Unpin tab') : (dict.pinTab || 'Pin tab');
  const lockLabel = tab.locked ? (dict.unlockTab || 'Unlock tab') : (dict.lockTab || 'Lock tab');
  menu.querySelector('[data-action="pin"]').textContent = pinLabel;
  menu.querySelector('[data-action="lock"]').textContent = lockLabel;

  const onClick = (e) => {
    const action = e.target.getAttribute('data-action');
    if (action === 'duplicate') api.duplicateTab(tab.id);
    if (action === 'pin') api.toggleTabPin(tab.id);
    if (action === 'hide') api.hideTab(tab.id);
    if (action === 'lock') api.toggleTabLock(tab.id);
    if (action === 'close' && !tab.locked) {
      api.closeTab(tab.id);
      delete tabOptions[tab.id];
    }
    hideContextMenu();
  };
  menu.querySelectorAll('.context-item').forEach((item) => {
    item.onclick = onClick;
  });
}

function hideContextMenu() {
  el('tab-context-menu').classList.add('hidden');
}
document.addEventListener('click', hideContextMenu);

async function refreshPrinters(selectPrinter) {
  const printers = await api.getPrinters();
  const dict = TRANSLATIONS[currentLang] || TRANSLATIONS.en;
  const statusSymbol = { ready: '●', busy: '◐', offline: '✕', unknown: '○' };
  const statusLabel = {
    ready: dict.printerReady,
    busy: dict.printerBusy,
    offline: dict.printerOffline,
    unknown: dict.printerUnknown
  };
  const select = el('printer-select');
  select.innerHTML = '';
  for (const p of printers) {
    const opt = document.createElement('option');
    opt.value = p.name;
    const sym = statusSymbol[p.status] || statusSymbol.unknown;
    const label = statusLabel[p.status] || statusLabel.unknown;
    opt.textContent = `${sym} ${p.displayName || p.name} — ${label}`;
    select.appendChild(opt);
  }
  if (selectPrinter) select.value = selectPrinter;
}

function loadToolbarForActiveTab() {
  const opts = tabOptions[activeTabId] || defaultOptions();
  tabOptions[activeTabId] = opts;

  el('copies-input').value = opts.copies;
  el('color-select').value = opts.color;
  el('pages-mode-select').value = opts.pagesMode;
  el('pages-range-input').value = opts.pageRangeText;
  el('pages-range-input').classList.toggle('hidden', opts.pagesMode !== 'custom');
  el('paper-size-select').value = opts.paperSize;
  el('pages-per-sheet-select').value = String(opts.pagesPerSheet);
  el('quality-select').value = String(opts.dpi);
  el('scale-mode-select').value = opts.scaleMode;
  el('scale-custom-input').value = opts.scaleCustom;
  el('scale-custom-input').classList.toggle('hidden', opts.scaleMode !== 'custom');
  el('duplex-checkbox').checked = opts.duplex;
  el('duplex-flip-select').value = opts.duplexFlip;
  el('duplex-flip-select').classList.toggle('hidden', !opts.duplex);

  const tab = currentTabs.find((t) => t.id === activeTabId);
  refreshPrinters(tab ? tab.printer : null);
}

// Builds the payload sent to main for an actual print job
function buildPrintPayload(opts, printerOverride) {
  return {
    printer: printerOverride,
    copies: opts.copies,
    color: opts.color === 'color',
    pagesMode: opts.pagesMode,
    pageRangeText: opts.pageRangeText,
    paperSize: opts.paperSize,
    scaleMode: opts.scaleMode,
    duplex: opts.duplex,
    duplexFlip: opts.duplexFlip,
    pagesPerSheet: parseInt(opts.pagesPerSheet, 10) || 1,
    dpi: parseInt(opts.dpi, 10) || 0
  };
}

// ---------- Events from main process ----------

api.onTabsUpdated(({ tabs }) => {
  currentTabs = tabs;
  const newActive = tabs.find((t) => t.active);
  const activeChanged = newActive && newActive.id !== activeTabId;
  activeTabId = newActive ? newActive.id : null;
  renderTabs();
  if (activeChanged || (activeTabId && !tabOptions[activeTabId])) {
    loadToolbarForActiveTab();
  }
});

api.onTriggerPrintActive(() => printActiveTab());
api.onTriggerPrintAll(() => printAllTabs());

// ---------- Toolbar control changes persist per tab ----------

function bindOption(elementId, field, transform = (v) => v) {
  el(elementId).addEventListener('change', () => {
    if (!activeTabId) return;
    tabOptions[activeTabId][field] = transform(el(elementId).value);
  });
}

el('copies-input').addEventListener('change', () => {
  if (!activeTabId) return;
  tabOptions[activeTabId].copies = parseInt(el('copies-input').value, 10) || 1;
});
bindOption('color-select', 'color');
el('color-select').addEventListener('change', () => {
  if (!activeTabId) return;
  api.setTabBW(activeTabId, el('color-select').value === 'bw');
});
bindOption('paper-size-select', 'paperSize');
bindOption('pages-per-sheet-select', 'pagesPerSheet', (v) => parseInt(v, 10));
bindOption('quality-select', 'dpi', (v) => parseInt(v, 10) || 0);

// Generate N-up preview when pages-per-sheet changes
el('pages-per-sheet-select').addEventListener('change', async () => {
  if (!activeTabId) return;
  const pagesPer = parseInt(el('pages-per-sheet-select').value, 10) || 1;
  const opts = tabOptions[activeTabId] || defaultOptions();
  const tab = currentTabs.find(t => t.id === activeTabId);
  if (!tab || !tab.filePath) return;
  if (pagesPer > 1) {
    const pageRange = opts.pagesMode === 'custom' ? opts.pageRangeText : null;
    // Use originalFilePath if available to avoid nesting previews
    const source = tab.originalFilePath || tab.filePath;
    const res = await api.createNupPreview({ filePath: source, pagesPerSheet: pagesPer, pageRangeText: pageRange });
    if (res.ok) {
      await api.loadPdfInActiveTab(res.path);
      showToast('N-up preview generated');
    } else if (res.error === 'too_large') {
      showToast('Document too large for N-up preview; preview skipped. N-up will be applied at print time.');
      // Keep original file in view
      await api.loadOriginalInActiveTab();
    } else {
      showToast('Failed to generate N-up preview');
    }
  } else {
    // reload original file
    await api.loadOriginalInActiveTab();
  }
});
bindOption('scale-custom-input', 'scaleCustom', (v) => parseInt(v, 10) || 100);
bindOption('duplex-flip-select', 'duplexFlip');

el('pages-mode-select').addEventListener('change', () => {
  const mode = el('pages-mode-select').value;
  el('pages-range-input').classList.toggle('hidden', mode !== 'custom');
  if (activeTabId) tabOptions[activeTabId].pagesMode = mode;
});
el('pages-range-input').addEventListener('input', () => {
  if (!activeTabId) return;
  tabOptions[activeTabId].pageRangeText = el('pages-range-input').value;
});
el('pages-range-input').addEventListener('change', async () => {
  if (!activeTabId) return;
  const range = el('pages-range-input').value.trim();
  if (range) {
    const tab = currentTabs.find(t => t.id === activeTabId);
    if (tab) {
      const result = await api.createFilteredPdfPreview(tab.filePath || tab.id, range);
      if (result.ok) {
        api.loadPdfInActiveTab(result.path);
      }
    }
  }
});
el('scale-mode-select').addEventListener('change', () => {
  const mode = el('scale-mode-select').value;
  el('scale-custom-input').classList.toggle('hidden', mode !== 'custom');
  if (activeTabId) tabOptions[activeTabId].scaleMode = mode;
});
el('duplex-checkbox').addEventListener('change', () => {
  const checked = el('duplex-checkbox').checked;
  el('duplex-flip-select').classList.toggle('hidden', !checked);
  if (activeTabId) tabOptions[activeTabId].duplex = checked;
});
el('printer-select').addEventListener('change', () => {
  if (!activeTabId) return;
  api.setTabPrinter(activeTabId, el('printer-select').value);
});

// ---------- More settings collapsible row ----------

function updateContentOffset() {
  const moreVisible = !el('more-settings').classList.contains('hidden');
  const extra = moreVisible ? el('more-settings').offsetHeight : 0;
  api.setContentOffset(extra);
  const top = 92 + extra;
  el('empty-state').style.top = top + 'px';
  el('history-panel').style.top = top + 'px';
}

el('more-settings-toggle').addEventListener('click', () => {
  el('more-settings').classList.toggle('hidden');
  updateContentOffset();
});

// ---------- Opening files ----------

el('new-tab-btn').addEventListener('click', () => api.openFileDialog());
el('empty-open-btn').addEventListener('click', () => api.openFileDialog());

// Drag & drop (only works over the tab bar / toolbar area — the PDF view
// itself is a native BrowserView and captures its own events)
for (const zoneId of ['tabbar', 'toolbar', 'empty-state']) {
  const zone = el(zoneId);
  zone.addEventListener('dragover', (e) => e.preventDefault());
  zone.addEventListener('drop', async (e) => {
    e.preventDefault();
    const paths = [];
    for (const file of e.dataTransfer.files) {
      const p = api.getPathForFile(file);
      if (p) paths.push(p);
    }
    if (paths.length) await api.openDroppedFiles(paths);
  });
}

// ---------- Printing ----------

function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 6000);
}

async function printActiveTab(confirmedLarge = false) {
  if (!activeTabId) return;
  const tab = currentTabs.find((t) => t.id === activeTabId);
  const opts = tabOptions[activeTabId];
  const options = buildPrintPayload(opts, tab ? tab.printer : el('printer-select').value);
  options.confirmedLarge = confirmedLarge;
  const result = await api.printTab(activeTabId, options);
  if (result.needsConfirmation) {
    showConfirmModal(result.pageCount, () => printActiveTab(true));
    return;
  }
  if (!result.ok) {
    showToast(`Print failed: ${result.error || 'Unknown error'}`);
    return;
  }
  if (result.advancedWarning) {
    const base = (TRANSLATIONS[currentLang] || TRANSLATIONS.en).advancedConfigWarning;
    showToast(`${base}\n${result.advancedWarning}`);
  } else {
    showToast('Print job sent');
  }
}

async function printAllTabs() {
  const jobs = currentTabs.map((t) => {
    const opts = tabOptions[t.id] || defaultOptions();
    const options = buildPrintPayload(opts, t.printer);
    options.confirmedLarge = true;
    return { id: t.id, options };
  });
  if (!jobs.length) return;
  const results = await api.printAllTabs(jobs);
  const failed = results.find((r) => r.advancedWarning);
  if (failed) {
    const base = (TRANSLATIONS[currentLang] || TRANSLATIONS.en).advancedConfigWarning;
    showToast(`${base}\n${failed.advancedWarning}`);
  }
}

el('print-active-btn').addEventListener('click', () => printActiveTab());
el('print-all-btn').addEventListener('click', () => printAllTabs());

function showConfirmModal(pageCount, onConfirm) {
  const modal = el('confirm-modal');
  el('confirm-text').textContent = `هذا الملف فيه ${pageCount} صفحة. متأكد تريد تطبعه؟`;
  modal.classList.remove('hidden');
  const ok = el('confirm-ok-btn');
  const cancel = el('confirm-cancel-btn');
  const cleanup = () => {
    modal.classList.add('hidden');
    ok.removeEventListener('click', okHandler);
    cancel.removeEventListener('click', cancelHandler);
  };
  const okHandler = () => { cleanup(); onConfirm(); };
  const cancelHandler = () => cleanup();
  ok.addEventListener('click', okHandler);
  cancel.addEventListener('click', cancelHandler);
}

// ---------- Presets ----------

async function refreshPresetList() {
  const presets = await api.getPresets();
  const select = el('preset-select');
  select.innerHTML = '<option value="">— بدون —</option>';
  for (const p of presets) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    select.appendChild(opt);
  }
  return presets;
}

el('preset-select').addEventListener('change', async () => {
  const presets = await api.getPresets();
  const preset = presets.find((p) => p.id === el('preset-select').value);
  if (!preset || !activeTabId) return;
  tabOptions[activeTabId] = { ...defaultOptions(), ...preset.options };
  loadToolbarForActiveTab();
  if (preset.printer) {
    api.setTabPrinter(activeTabId, preset.printer);
  }
});

el('save-preset-btn').addEventListener('click', () => {
  el('preset-modal').classList.remove('hidden');
  el('preset-name-input').value = '';
  el('preset-name-input').focus();
});
el('preset-cancel-btn').addEventListener('click', () => el('preset-modal').classList.add('hidden'));
el('preset-confirm-btn').addEventListener('click', async () => {
  const name = el('preset-name-input').value.trim();
  if (!name || !activeTabId) return;
  const tab = currentTabs.find((t) => t.id === activeTabId);
  await api.savePreset({
    name,
    options: tabOptions[activeTabId],
    printer: tab ? tab.printer : null
  });
  el('preset-modal').classList.add('hidden');
  await refreshPresetList();
});

// ---------- History ----------

el('history-btn').addEventListener('click', async () => {
  el('history-panel').classList.remove('hidden');
  await renderHistory();
});
el('close-history-btn').addEventListener('click', () => el('history-panel').classList.add('hidden'));
el('clear-history-btn').addEventListener('click', async () => {
  await api.clearHistory();
  await renderHistory();
});

async function renderHistory() {
  const history = await api.getHistory();
  const list = el('history-list');
  list.innerHTML = '';
  if (!history.length) {
    list.innerHTML = '<p style="color:#9aa0a6;font-size:12px;">لا يوجد سجل بعد</p>';
    return;
  }

// ========== KillerPDF FEATURES: View Modes ==========
// Per-tab view mode state
const tabViewModes = {};

function getViewMode(tabId) {
  return tabViewModes[tabId] || 'single';
}

function setViewMode(tabId, mode) {
  tabViewModes[tabId] = mode;
  updateViewModeButtons(mode);
  // In a full implementation, apply this to the PDF viewer via CSS transforms or plugin
  // For now, we store the preference per tab
}

function updateViewModeButtons(activeMode) {
  document.querySelectorAll('.view-btn').forEach(btn => {
    btn.classList.remove('active');
  });
  if (activeMode === 'single') el('view-single-btn').classList.add('active');
  else if (activeMode === 'continuous') el('view-continuous-btn').classList.add('active');
  else if (activeMode === 'two-page') el('view-two-page-btn').classList.add('active');
  else if (activeMode === 'grid') el('view-grid-btn').classList.add('active');
}

el('view-single-btn').addEventListener('click', () => {
  if (activeTabId) setViewMode(activeTabId, 'single');
  showToast('📄 Single page mode');
});

el('view-continuous-btn').addEventListener('click', () => {
  if (activeTabId) setViewMode(activeTabId, 'continuous');
  showToast('∞ Continuous scroll mode');
});

el('view-two-page-btn').addEventListener('click', () => {
  if (activeTabId) setViewMode(activeTabId, 'two-page');
  showToast('📖 Two-page view');
});

el('view-grid-btn').addEventListener('click', () => {
  if (activeTabId) setViewMode(activeTabId, 'grid');
  showToast('⊞ Grid view (thumbnails)');
});

// ========== KillerPDF FEATURES: Text Search ==========
let searchMatches = [];
let searchCurrentIndex = 0;

el('search-input').addEventListener('keyup', async (e) => {
  const query = e.target.value.trim();
  if (!query) {
    searchMatches = [];
    searchCurrentIndex = 0;
    el('search-count').textContent = '';
    return;
  }
  // Full-text search across PDF - would be implemented via PDF.js or similar
  // For now, we show a placeholder
  if (activeTabId) {
    // In a complete implementation, query the PDF library for text matches
    el('search-count').textContent = `0 / 0`;
  }
});

el('search-prev-btn').addEventListener('click', () => {
  if (searchMatches.length === 0) return;
  searchCurrentIndex = (searchCurrentIndex - 1 + searchMatches.length) % searchMatches.length;
  // Highlight and navigate to match
  showToast(`Result ${searchCurrentIndex + 1} / ${searchMatches.length}`);
});

el('search-next-btn').addEventListener('click', () => {
  if (searchMatches.length === 0) return;
  searchCurrentIndex = (searchCurrentIndex + 1) % searchMatches.length;
  // Highlight and navigate to match
  showToast(`Result ${searchCurrentIndex + 1} / ${searchMatches.length}`);
});

// ========== KillerPDF FEATURES: Page Tools ==========

el('rotate-left-btn').addEventListener('click', () => {
  if (activeTabId) {
    showToast('↺ Rotate left 90° (feature coming)');
    // TODO: implement rotation via pdf-lib
  }
});

el('rotate-right-btn').addEventListener('click', () => {
  if (activeTabId) {
    showToast('↻ Rotate right 90° (feature coming)');
    // TODO: implement rotation via pdf-lib
  }
});

el('crop-btn').addEventListener('click', () => {
  if (activeTabId) {
    showToast('✂ Crop tool (feature coming - click corners to adjust)');
    // TODO: implement crop UI with corner handles
  }
});

el('delete-page-btn').addEventListener('click', () => {
  if (activeTabId) {
    showToast('🗑 Delete current page (feature coming)');
    // TODO: implement page deletion via pdf-lib
  }
});

// ========== KillerPDF FEATURES: Annotation Tools ==========

let annotationMode = null; // 'draw', 'highlight', 'text', or null

el('annotate-draw-btn').addEventListener('click', () => {
  annotationMode = annotationMode === 'draw' ? null : 'draw';
  el('annotate-draw-btn').classList.toggle('active');
  if (annotationMode === 'draw') {
    showToast('✏ Draw mode active - draw on PDF');
  } else {
    showToast('✏ Draw mode disabled');
  }
});

el('annotate-highlight-btn').addEventListener('click', () => {
  annotationMode = annotationMode === 'highlight' ? null : 'highlight';
  el('annotate-highlight-btn').classList.toggle('active');
  if (annotationMode === 'highlight') {
    showToast('🖍 Highlight mode active - select text to highlight');
  } else {
    showToast('🖍 Highlight mode disabled');
  }
});

el('annotate-text-btn').addEventListener('click', () => {
  annotationMode = annotationMode === 'text' ? null : 'text';
  el('annotate-text-btn').classList.toggle('active');
  if (annotationMode === 'text') {
    showToast('T Add text - click to place text box');
  } else {
    showToast('T Text mode disabled');
  }
});

// ========== KillerPDF FEATURES: OCR ==========

el('ocr-btn').addEventListener('click', async () => {
  if (!activeTabId) {
    showToast('No PDF open');
    return;
  }
  const tab = currentTabs.find(t => t.id === activeTabId);
  if (!tab) return;

  el('ocr-btn').disabled = true;
  showToast('👁 OCR in progress... scanning document');

  try {
    // TODO: Call backend OCR handler (requires Tesseract.js)
    // const result = await api.runOcr(tab.filePath);
    // if (result.ok) {
    //   showToast(`✅ OCR complete: ${result.pagesScanned} pages processed`);
    // } else {
    //   showToast(`❌ OCR failed: ${result.error}`);
    // }
    showToast('👁 OCR support coming soon - requires Tesseract.js integration');
  } catch (e) {
    showToast(`OCR error: ${e.message}`);
  } finally {
    el('ocr-btn').disabled = false;
  }
});

// ========== KillerPDF FEATURES: Keyboard Shortcuts ==========

document.addEventListener('keydown', (e) => {
  // Alt+Left: previous page / jump history
  if (e.altKey && e.key === 'ArrowLeft') {
    e.preventDefault();
    showToast('◀ Previous (jump history coming)');
  }
  // Alt+Right: next page / jump history
  if (e.altKey && e.key === 'ArrowRight') {
    e.preventDefault();
    showToast('▶ Next (jump history coming)');
  }
  // F11: fullscreen
  if (e.key === 'F11') {
    e.preventDefault();
    document.documentElement.requestFullscreen().catch(err => {});
  }
  // F10: split pane
  if (e.key === 'F10') {
    e.preventDefault();
    showToast('F10: Split pane (feature coming)');
  }
  // Ctrl+F: search
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
    e.preventDefault();
    el('search-input').focus();
  }
});
  for (const h of history) {
    const div = document.createElement('div');
    div.className = 'history-item';
    const date = new Date(h.timestamp).toLocaleString('ar-IQ');
    div.innerHTML = `<div class="h-file">${h.fileName}</div><div class="h-meta">${h.printer} • ${h.pages} صفحة × ${h.copies} نسخة • ${date}</div>`;
    list.appendChild(div);
  }
}

el('language-select').addEventListener('change', async () => {
  currentLang = el('language-select').value;
  await api.setLanguage(currentLang);
  applyTranslations(currentLang);
  await refreshPrinters(el('printer-select').value);
});

// ---------- Theme switching ----------
function setTheme(themeName) {
  document.body.setAttribute('data-theme', themeName);
  api.setTheme(themeName);
}

el('theme-select').addEventListener('change', () => {
  setTheme(el('theme-select').value);
});

// ---------- Init ----------

(async function init() {
  currentLang = (await api.getLanguage()) || 'en';
  el('language-select').value = currentLang;
  applyTranslations(currentLang);

  // Load and apply theme
  const savedTheme = (await api.getTheme()) || 'dark';
  el('theme-select').value = savedTheme;
  setTheme(savedTheme);

  const state = await api.getTabsState();
  currentTabs = state.tabs;
  const active = currentTabs.find((t) => t.active);
  activeTabId = active ? active.id : null;
  renderTabs();
  await refreshPresetList();
  await refreshPrinters();
  updateContentOffset();
})();
