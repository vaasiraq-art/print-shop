const { app, BrowserWindow, BrowserView, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const crypto = require('crypto');
const os = require('os');
const Store = require('electron-store');
const { PDFDocument } = require('pdf-lib');
const {
  print: printPdfSilently,
  getPrinters: getSystemPrinters,
  getDefaultPrinter
} = require('pdf-to-printer');

const store = new Store({
  defaults: { presets: [], history: [], language: 'en', theme: 'dark' }
});

// Layout constants (px) — space reserved above the BrowserView for our custom UI
const TABBAR_HEIGHT = 40;
const TOOLBAR_HEIGHT = 52;
const BASE_TOP_OFFSET = TABBAR_HEIGHT + TOOLBAR_HEIGHT;
let extraTopOffset = 0; // grows when the "more settings" row is expanded, set via IPC
const LARGE_FILE_WARNING_PAGES = 50;

let mainWindow = null;
/** @type {Map<string, {view: BrowserView, filePath: string, title: string, pageCount: number, printer: string|null, locked: boolean, bw: boolean}>} */
const tabs = new Map();
let activeTabId = null;
let tabCounter = 0;
let pendingFileToOpen = null; // a .pdf passed on the command line before the window exists

// ---------- Single instance / "open with" support ----------
// When the app is set as the default PDF handler, Windows launches a new
// process with the file path as an argv — we forward that into the already
// running window instead of opening a second app.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (event, argv) => {
    const filePath = argv.find((a) => a.toLowerCase().endsWith('.pdf'));
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      if (filePath) createTab(filePath);
    }
  });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    title: 'Print Shop'
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  mainWindow.webContents.once('did-finish-load', () => {
    const argFile = process.argv.find((a) => a.toLowerCase().endsWith('.pdf'));
    const fileToOpen = pendingFileToOpen || argFile;
    if (fileToOpen && fs.existsSync(fileToOpen)) {
      createTab(fileToOpen);
    }
  });

  mainWindow.on('resize', () => layoutActiveView());

  buildMenu();
}

function layoutActiveView() {
  if (!activeTabId) return;
  const tab = tabs.get(activeTabId);
  if (!tab) return;
  const bounds = mainWindow.getContentBounds();
  const offset = BASE_TOP_OFFSET + extraTopOffset;
  tab.view.setBounds({
    x: 0,
    y: offset,
    width: bounds.width,
    height: Math.max(0, bounds.height - offset)
  });
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function serializeTabs() {
  return Array.from(tabs.entries()).map(([id, t]) => ({
    id,
    title: t.title,
    pageCount: t.pageCount,
    printer: t.printer,
    locked: t.locked,
    bw: t.bw,
    active: id === activeTabId
  }));
}

function broadcastTabs() {
  sendToRenderer('tabs-updated', { tabs: serializeTabs(), totalPages: getTotalPages() });
}

// Fast page count: scan raw bytes for "/Type /Page" markers instead of
// building pdf-lib's full object graph. This is what previously froze the
// whole app ("Not Responding") on big PDFs — it ran on the Main process,
// which is single-threaded, so any heavy synchronous work blocks the UI.
// Now it also runs *after* the tab is already visible, never before.
async function getPageCountFast(filePath) {
  try {
    const buffer = await fs.promises.readFile(filePath);
    const text = buffer.toString('latin1');
    const matches = text.match(/\/Type\s*\/Page[^s]/g);
    if (matches && matches.length > 0) return matches.length;
    // Fallback for PDFs with compressed cross-reference streams where the
    // regex scan can't see page objects directly.
    const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
    return doc.getPageCount();
  } catch (e) {
    return 0;
  }
}

async function createTab(filePath, options = {}) {
  if (!filePath || !fs.existsSync(filePath)) return null;

  const id = `tab-${++tabCounter}`;
  const view = new BrowserView({
    webPreferences: {
      plugins: true, // enables Chromium's native PDF viewer with full toolbar
      contextIsolation: true,
      backgroundThrottling: true
    }
  });

  const title = options.title || path.basename(filePath);

  let defaultPrinterName = options.printer || null;
  if (!defaultPrinterName) {
    try {
      const defaultPrinter = await getDefaultPrinter();
      defaultPrinterName = defaultPrinter ? defaultPrinter.name : null;
    } catch (e) {
      // no default printer configured — user must pick one
    }
  }

  tabs.set(id, {
    view,
    filePath,
    title,
    pageCount: 0, // filled in asynchronously below, off the critical path
    printer: defaultPrinterName,
    locked: false,
    bw: false
  });

  mainWindow.addBrowserView(view);
  // Not awaited on purpose — let Chromium load/render the PDF in the
  // background while we immediately show the tab and hand control back.
  view.webContents.loadURL('file://' + encodeURI(filePath.replace(/\\/g, '/')));

  await switchTab(id);
  broadcastTabs();

  getPageCountFast(filePath).then((count) => {
    const t = tabs.get(id);
    if (t) {
      t.pageCount = count;
      broadcastTabs();
    }
  });

  return id;
}

async function switchTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;

  if (activeTabId && tabs.has(activeTabId)) {
    mainWindow.removeBrowserView(tabs.get(activeTabId).view);
  }

  activeTabId = id;
  mainWindow.addBrowserView(tab.view);
  layoutActiveView();
  broadcastTabs();
}

function closeTab(id) {
  const tab = tabs.get(id);
  if (!tab || tab.locked) return false;

  mainWindow.removeBrowserView(tab.view);
  tab.view.webContents.destroy();
  tabs.delete(id);

  if (activeTabId === id) {
    activeTabId = null;
    const remaining = Array.from(tabs.keys());
    if (remaining.length > 0) {
      switchTab(remaining[remaining.length - 1]);
    }
  }
  broadcastTabs();
  return true;
}

async function duplicateTab(id) {
  const tab = tabs.get(id);
  if (!tab) return null;
  return createTab(tab.filePath, { title: tab.title, printer: tab.printer });
}

function toggleLock(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  tab.locked = !tab.locked;
  broadcastTabs();
}

async function setTabBlackAndWhite(id, bw) {
  const tab = tabs.get(id);
  if (!tab) return;
  tab.bw = bw;
  try {
    if (bw) {
      tab.bwCssKey = await tab.view.webContents.insertCSS(
        'html { filter: grayscale(100%) !important; }'
      );
    } else if (tab.bwCssKey) {
      await tab.view.webContents.removeInsertedCSS(tab.bwCssKey);
      tab.bwCssKey = null;
    }
  } catch (e) {
    // view may still be loading — ignore, this is a cosmetic preview only
  }
  broadcastTabs();
}

function getTotalPages() {
  let sum = 0;
  for (const t of tabs.values()) sum += t.pageCount || 0;
  return sum;
}

function addHistoryEntry(entry) {
  const history = store.get('history');
  history.unshift({ ...entry, timestamp: new Date().toISOString() });
  store.set('history', history.slice(0, 500));
}

// ---------- Advanced printer config: Pages-per-sheet + literal DPI ----------
// Konica Minolta bizhub C458 (Universal V4 PCL driver) uses custom XML namespaces
// for PrintTicket options. Generic names like "PagesPerSheet" don't work.
// This function builds the exact PrintTicketXML structure that Konica's driver expects:
// - Combination feature for N-up (2in1, 4in1, etc.)
// - psf:ParameterInit for Resolution (600dpi/1200dpi)
// Based on actual Get-PrintConfiguration output from the user's driver.
function applyAdvancedPrinterConfig(printerName, { pagesPerSheet, dpi }) {
  return new Promise((resolve) => {
    if ((!pagesPerSheet || pagesPerSheet <= 1) && (!dpi || dpi <= 0)) {
      return resolve({ ok: true, skipped: true });
    }
    const safeName = printerName.replace(/"/g, '`"');
    
    // Build Konica-specific PrintTicket XML
    // Reference: User's actual PrintTicketXML from Get-PrintConfiguration
    let xmlParts = [
      '<?xml version="1.0"?>',
      '<psf:PrintTicket xmlns:psf="http://schemas.microsoft.com/windows/2003/08/printing/printschemaframework"',
      ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
      ' xmlns:xsd="http://www.w3.org/2001/XMLSchema"',
      ' xmlns:ns0000="http://schemas.konicaminolta.jp/windows/printing/2006/09/PrintTicketExt"',
      ' version="1">'
    ];

    // Add Combination (N-up) setting if specified
    if (pagesPerSheet && pagesPerSheet > 1) {
      const comboValue = pagesPerSheet === 2 ? '2in1' : 
                         pagesPerSheet === 4 ? '4in1' : 
                         pagesPerSheet === 6 ? '6in1' : 
                         pagesPerSheet === 9 ? '9in1' : '16in1';
      xmlParts.push(
        `<psf:Feature name="Combination">`,
        `<psf:Option name="${comboValue}" selected="yes">`,
        `</psf:Option>`,
        `</psf:Feature>`
      );
    }

    // Add Resolution (DPI) setting if specified
    if (dpi && dpi > 0) {
      // Konica uses ParameterInit with Name="Resolution" and Value attribute
      xmlParts.push(
        `<psf:Feature name="DeviceSettings">`,
        `<psf:ParameterInit name="Resolution">`,
        `<psf:Value xsi:type="xsd:string">${dpi}dpi</psf:Value>`,
        `</psf:ParameterInit>`,
        `</psf:Feature>`
      );
    }

    xmlParts.push('</psf:PrintTicket>');
    const printTicketXml = xmlParts.join('');

    // PowerShell command to apply the PrintTicket
    const psCommand = `
      $ErrorActionPreference = "Stop";
      $ticketXml = @"
${printTicketXml}
"@;
      Set-PrintConfiguration -PrinterName "${safeName}" -PrintTicketXml $ticketXml
    `.trim().replace(/\n/g, '; ');

    execFile(
      'powershell.exe',
      ['-NoProfile', '-Command', psCommand],
      { timeout: 8000 },
      (err, stdout, stderr) => {
        if (err) {
          resolve({ ok: false, error: (stderr || String(err)).slice(0, 400) });
        } else {
          resolve({ ok: true });
        }
      }
    );
  });
}

async function printTab(id, options) {
  const tab = tabs.get(id);
  if (!tab) return { ok: false, error: 'Tab not found' };

  const printerName = options.printer;
  if (!printerName) {
    return { ok: false, error: 'No printer selected for this tab' };
  }

  let advancedWarning = null;
  const advResult = await applyAdvancedPrinterConfig(printerName, {
    pagesPerSheet: options.pagesPerSheet,
    dpi: options.dpi
  });
  if (!advResult.ok) advancedWarning = advResult.error;

  const printOptions = {
    printer: printerName,
    monochrome: options.color === false,
    side: options.duplex
      ? options.duplexFlip === 'short'
        ? 'duplexshort'
        : 'duplexlong'
      : 'simplex',
    scale: options.scaleMode === 'default' ? 'noscale' : 'fit'
  };
  if (options.paperSize) printOptions.paperSize = options.paperSize;
  if (options.pagesMode === 'custom' && options.pageRangeText) {
    printOptions.pages = options.pageRangeText;
  }
  printOptions.copies = Math.max(1, parseInt(options.copies, 10) || 1);

  try {
    await printPdfSilently(tab.filePath, printOptions);
    addHistoryEntry({
      fileName: tab.title,
      printer: printerName,
      pages: tab.pageCount,
      copies: printOptions.copies
    });
    return { ok: true, advancedWarning };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

// ---------- Printer status (Ready / Busy / Offline) ----------
// Windows has no universal ink-level API (that's vendor/driver specific),
// but PrinterStatus + WorkOffline from PowerShell's Get-Printer is reliable
// across manufacturers for ready/busy/offline state.
function getPrinterStatuses() {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        'Get-Printer | Select-Object Name,PrinterStatus,WorkOffline | ConvertTo-Json'
      ],
      { timeout: 5000 },
      (err, stdout) => {
        if (err || !stdout) return resolve({});
        try {
          let parsed = JSON.parse(stdout);
          if (!Array.isArray(parsed)) parsed = [parsed];
          const map = {};
          for (const p of parsed) {
            let status = 'unknown';
            if (p.WorkOffline) status = 'offline';
            else if (p.PrinterStatus === 'Normal' || p.PrinterStatus === 0) status = 'ready';
            else if (p.PrinterStatus === 'Printing' || p.PrinterStatus === 'Processing') status = 'busy';
            else if (p.PrinterStatus) status = 'busy';
            map[p.Name] = status;
          }
          resolve(map);
        } catch (e) {
          resolve({});
        }
      }
    );
  });
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Open PDF...',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const result = await dialog.showOpenDialog(mainWindow, {
              properties: ['openFile', 'multiSelections'],
              filters: [{ name: 'PDF Files', extensions: ['pdf'] }]
            });
            for (const filePath of result.filePaths) {
              await createTab(filePath);
            }
          }
        },
        {
          label: 'Close Tab',
          accelerator: 'CmdOrCtrl+W',
          click: () => {
            if (activeTabId) closeTab(activeTabId);
          }
        },
        { type: 'separator' },
        {
          label: 'Print Active Tab',
          accelerator: 'CmdOrCtrl+P',
          click: () => sendToRenderer('trigger-print-active', {})
        },
        {
          label: 'Print All Tabs',
          accelerator: 'CmdOrCtrl+Shift+P',
          click: () => sendToRenderer('trigger-print-all', {})
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'View',
      submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- IPC handlers ----------

ipcMain.handle('open-file-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'PDF Files', extensions: ['pdf'] }]
  });
  const ids = [];
  for (const filePath of result.filePaths) {
    const id = await createTab(filePath);
    if (id) ids.push(id);
  }
  return ids;
});

ipcMain.handle('open-dropped-files', async (event, filePaths) => {
  const extractZip = require('extract-zip');
  const ids = [];
  
  for (const filePath of filePaths) {
    const ext = path.extname(filePath).toLowerCase();
    
    if (ext === '.pdf') {
      // Regular PDF
      const id = await createTab(filePath);
      if (id) ids.push(id);
    } else if (ext === '.zip') {
      // Extract and process archive
      try {
        const tempDir = path.join(os.tmpdir(), `print-shop-${Date.now()}`);
        await extractZip(filePath, { dir: tempDir });
        
        // Find all images and PDFs
        const files = [];
        const walkDir = async (dir) => {
          const entries = await fs.promises.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              await walkDir(fullPath);
            } else {
              const e = path.extname(entry.name).toLowerCase();
              if (['.pdf', '.jpg', '.jpeg', '.png', '.gif', '.bmp'].includes(e)) {
                files.push(fullPath);
              }
            }
          }
        };
        
        await walkDir(tempDir);
        
        // Separate PDFs and images
        const pdfs = files.filter(f => f.toLowerCase().endsWith('.pdf'));
        const images = files.filter(f => ['.jpg', '.jpeg', '.png', '.gif', '.bmp'].some(ext => f.toLowerCase().endsWith(ext)));
        
        // Open PDFs directly
        for (const pdf of pdfs.sort()) {
          const id = await createTab(pdf);
          if (id) ids.push(id);
        }
        
        // Merge images into a single PDF if any exist
        if (images.length > 0) {
          try {
            const pdfDoc = await PDFDocument.create();
            for (const imgPath of images.sort()) {
              try {
                const imgBuffer = await fs.promises.readFile(imgPath);
                const image = await pdfDoc.embedJpeg(imgBuffer).catch(() => pdfDoc.embedPng(imgBuffer));
                const page = pdfDoc.addPage([595, 842]); // A4
                page.drawImage(image, { x: 0, y: 0, width: 595, height: 842 });
              } catch (e) {
                console.error(`Error processing image ${imgPath}:`, e);
              }
            }
            const pdfBuffer = await pdfDoc.save();
            const mergedPath = path.join(os.tmpdir(), `print-shop-merged-${Date.now()}.pdf`);
            await fs.promises.writeFile(mergedPath, pdfBuffer);
            const id = await createTab(mergedPath, { title: `${path.basename(filePath, '.zip')} (merged images)` });
            if (id) ids.push(id);
          } catch (e) {
            console.error('Error merging images:', e);
          }
        }
      } catch (e) {
        console.error('Error extracting ZIP:', e);
      }
    } else if (['.jpg', '.jpeg', '.png', '.gif', '.bmp'].some(img => ext === img)) {
      // Single image - log that batch merge is available via ZIP
      console.log(`Image file ${filePath} - use ZIP for batch processing`);
    }
  }
  
  return ids;
});

ipcMain.handle('get-printers', async () => {
  try {
    const [printers, statuses] = await Promise.all([getSystemPrinters(), getPrinterStatuses()]);
    return printers.map((p) => ({
      name: p.name,
      displayName: p.name,
      status: statuses[p.name] || 'unknown'
    }));
  } catch (e) {
    return [];
  }
});

ipcMain.handle('switch-tab', async (event, id) => switchTab(id));
ipcMain.handle('close-tab', async (event, id) => closeTab(id));
ipcMain.handle('duplicate-tab', async (event, id) => duplicateTab(id));
ipcMain.handle('toggle-tab-lock', async (event, id) => toggleLock(id));
ipcMain.handle('set-tab-bw', async (event, { id, bw }) => setTabBlackAndWhite(id, bw));

ipcMain.handle('set-tab-printer', async (event, { id, printer }) => {
  const tab = tabs.get(id);
  if (tab) tab.printer = printer;
  broadcastTabs();
});

ipcMain.handle('print-tab', async (event, { id, options }) => {
  const tab = tabs.get(id);
  if (tab && tab.pageCount >= LARGE_FILE_WARNING_PAGES && !options.confirmedLarge) {
    return { ok: false, needsConfirmation: true, pageCount: tab.pageCount };
  }
  return printTab(id, options);
});

ipcMain.handle('print-all-tabs', async (event, jobs) => {
  const results = [];
  for (const job of jobs) {
    const result = await printTab(job.id, job.options);
    results.push({ id: job.id, ...result });
  }
  return results;
});

ipcMain.handle('get-presets', () => store.get('presets'));

ipcMain.handle('save-preset', (event, preset) => {
  const presets = store.get('presets');
  presets.push({ id: `preset-${Date.now()}`, ...preset });
  store.set('presets', presets);
  return presets;
});

ipcMain.handle('delete-preset', (event, presetId) => {
  const presets = store.get('presets').filter((p) => p.id !== presetId);
  store.set('presets', presets);
  return presets;
});

ipcMain.handle('get-history', () => store.get('history'));

ipcMain.handle('clear-history', () => {
  store.set('history', []);
  return [];
});

ipcMain.handle('set-content-offset', (event, px) => {
  extraTopOffset = px || 0;
  layoutActiveView();
});

ipcMain.handle('get-language', () => store.get('language'));
ipcMain.handle('set-language', (event, lang) => {
  store.set('language', lang);
  return lang;
});

ipcMain.handle('get-theme', () => store.get('theme') || 'dark');
ipcMain.handle('set-theme', (event, theme) => {
  store.set('theme', theme);
  return theme;
});

ipcMain.handle('get-tabs-state', () => ({
  tabs: serializeTabs(),
  totalPages: getTotalPages()
}));

// ---------- Page filtering for preview ----------
// Creates a filtered PDF with only selected pages and returns its path
async function createFilteredPdfPreview(filePath, pageRangeText) {
  try {
    const buffer = await fs.promises.readFile(filePath);
    const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
    const totalPages = doc.getPageCount();
    
    // Parse page range (e.g., "1,3,5-7" -> [1,3,5,6,7])
    const pages = new Set();
    for (const part of pageRangeText.split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      if (trimmed.includes('-')) {
        const [start, end] = trimmed.split('-').map(s => parseInt(s.trim(), 10));
        for (let i = start; i <= end && i <= totalPages; i++) {
          pages.add(i - 1); // 0-indexed
        }
      } else {
        const page = parseInt(trimmed, 10);
        if (page > 0 && page <= totalPages) pages.add(page - 1);
      }
    }
    
    if (pages.size === 0) return null;
    
    // Create new doc with only selected pages
    const newDoc = await PDFDocument.create();
    const sortedPages = Array.from(pages).sort((a, b) => a - b);
    
    for (const pageIdx of sortedPages) {
      const [copiedPage] = await newDoc.copyPages(doc, [pageIdx]);
      newDoc.addPage(copiedPage);
    }
    
    const filteredBuffer = await newDoc.save();
    
    // Save to temp file
    const tempDir = os.tmpdir();
    const hash = crypto.createHash('md5').update(filePath + pageRangeText).digest('hex');
    const tempPath = path.join(tempDir, `print-shop-preview-${hash}.pdf`);
    
    await fs.promises.writeFile(tempPath, filteredBuffer);
    return tempPath;
  } catch (e) {
    console.error('Error creating filtered PDF:', e);
    return null;
  }
}

ipcMain.handle('create-filtered-pdf-preview', async (event, { filePath, pageRangeText }) => {
  if (!pageRangeText || !pageRangeText.trim()) return { ok: false, error: 'Invalid page range' };
  const result = await createFilteredPdfPreview(filePath, pageRangeText);
  return result ? { ok: true, path: result } : { ok: false, error: 'Failed to create preview' };
});

ipcMain.handle('load-pdf-in-active-tab', async (event, { filePath }) => {
  if (!activeTabId) return { ok: false, error: 'No active tab' };
  const tab = tabs.get(activeTabId);
  if (!tab) return { ok: false, error: 'Tab not found' };
  
  const fileUrl = `file:///${filePath.replace(/\\/g, '/')}`;
  tab.view.webContents.loadURL(fileUrl);
  return { ok: true };
});

app.whenReady().then(createMainWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});
