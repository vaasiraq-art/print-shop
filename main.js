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
/** @type {Map<string, {view: BrowserView|null, filePath: string, title: string, pageCount: number, printer: string|null, locked: boolean, bw: boolean, pinned?: boolean, hidden?: boolean, lastAccess?: number}>} */
const tabs = new Map();
let activeTabId = null;
let tabCounter = 0;
let pendingFileToOpen = null; // a .pdf passed on the command line before the window exists

// Limit number of live BrowserViews to avoid high memory use. Other tabs are
// lazy-loaded when activated. Tune as needed.
const MAX_ACTIVE_VIEWS = 3;

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
  // Include filePath and originalFilePath so renderer can decide which tabs to show
  return Array.from(tabs.entries()).map(([id, t]) => ({
    id,
    title: t.title,
    filePath: t.filePath || null,
    originalFilePath: t.originalFilePath || null,
    pageCount: t.pageCount,
    printer: t.printer,
    locked: t.locked,
    bw: t.bw,
    pinned: !!t.pinned,
    hidden: !!t.hidden,
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

async function getPageCountFast(filePath) {
  // Offload counting to a child Node process that streams the file so the
  // main event loop isn't blocked by large-memory allocations or heavy regex.
  return new Promise((resolve) => {
    const workerScript = path.join(__dirname, 'pageCountWorker.js');
    execFile(process.execPath, [workerScript, filePath], { timeout: 15000 }, (err, stdout) => {
      if (err) {
        // Fallback: try lightweight pdf-lib method
        fs.promises.readFile(filePath).then((buffer) => {
          PDFDocument.load(buffer, { ignoreEncryption: true }).then((doc) => resolve(doc.getPageCount())).catch(() => resolve(0));
        }).catch(() => resolve(0));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        if (parsed && typeof parsed.count === 'number' && parsed.count > 0) return resolve(parsed.count);
        // fallback
        fs.promises.readFile(filePath).then((buffer) => {
          PDFDocument.load(buffer, { ignoreEncryption: true }).then((doc) => resolve(doc.getPageCount())).catch(() => resolve(0));
        }).catch(() => resolve(0));
      } catch (e) {
        resolve(0);
      }
    });
  });
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

  // Store both original source path and current filePath (current may be a preview)
  tabs.set(id, {
    view,
    originalFilePath: filePath,
    filePath,
    title,
    pageCount: 0, // filled in asynchronously below, off the critical path
    printer: defaultPrinterName,
    locked: false,
    bw: false,
    pinned: false,
    hidden: false,
    lastAccess: Date.now()
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

  // Remove current view if present
  if (activeTabId && tabs.has(activeTabId)) {
    const prev = tabs.get(activeTabId);
    if (prev && prev.view) {
      try {
        mainWindow.removeBrowserView(prev.view);
      } catch (e) {}
    }
  }

  activeTabId = id;

  // If new tab doesn't have an active BrowserView, create and load it lazily.
  if (!tab.view) {
    // Enforce max active views by evicting least recently used non-active view
    const activeViews = Array.from(tabs.values()).filter(t => t.view);
    if (activeViews.length >= MAX_ACTIVE_VIEWS) {
      // find LRU view that's not pinned and not the tab we're activating
      let lruId = null; let lruTime = Infinity;
      for (const [tid, tdata] of tabs.entries()) {
        if (tdata.view && tid !== id && !tdata.pinned) {
          const at = tdata.lastAccess || 0;
          if (at < lruTime) { lruTime = at; lruId = tid; }
        }
      }
      if (lruId) {
        const evicted = tabs.get(lruId);
        try { mainWindow.removeBrowserView(evicted.view); } catch (e) {}
        try { evicted.view.webContents.destroy(); } catch (e) {}
        evicted.view = null;
      }
    }

    const view = new BrowserView({ webPreferences: { plugins: true, contextIsolation: true, backgroundThrottling: true } });
    tab.view = view;
    mainWindow.addBrowserView(view);
    // Load file URL
    try {
      view.webContents.loadURL('file://' + encodeURI(tab.filePath.replace(/\\/g, '/')));
    } catch (e) {
      console.error('Failed to load PDF in BrowserView:', e);
    }
  } else {
    try { mainWindow.addBrowserView(tab.view); } catch (e) {}
  }

  tab.lastAccess = Date.now();
  layoutActiveView();
  broadcastTabs();
}

function closeTab(id) {
  const tab = tabs.get(id);
  if (!tab || tab.locked) return false;

  try {
    mainWindow.removeBrowserView(tab.view);
  } catch (e) {}
  try {
    tab.view.webContents.destroy();
  } catch (e) {}
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

function togglePin(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  tab.pinned = !tab.pinned;
  broadcastTabs();
}

function hideTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  tab.hidden = true;
  // If active, switch to next visible tab
  if (activeTabId === id) {
    activeTabId = null;
    for (const [tid, t] of tabs.entries()) {
      if (!t.hidden) { switchTab(tid); break; }
    }
  }
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

const PRINT_LOG_PATH = path.join(os.tmpdir(), 'print-shop-print.log');

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

  // Log attempt
  try {
    fs.appendFileSync(PRINT_LOG_PATH, `${new Date().toISOString()} - Printing ${tab.title} to ${printerName} with options ${JSON.stringify(printOptions)}\n`);
  } catch (e) {}

  try {
    await printPdfSilently(tab.filePath, printOptions);
    addHistoryEntry({
      fileName: tab.title,
      printer: printerName,
      pages: tab.pageCount,
      copies: printOptions.copies
    });
    fs.appendFileSync(PRINT_LOG_PATH, `${new Date().toISOString()} - printPdfSilently succeeded\n`);
    return { ok: true, advancedWarning };
  } catch (e) {
    const errMsg = String(e && e.message ? e.message : e);
    fs.appendFileSync(PRINT_LOG_PATH, `${new Date().toISOString()} - printPdfSilently failed: ${errMsg}\n`);
    // Primary print method failed — attempt fallback using BrowserView's print
    console.error('pdf-to-printer failed:', errMsg);
    if (tab.view && tab.view.webContents) {
      try {
        const printResult = await new Promise((resolve) => {
          tab.view.webContents.print({ silent: true, deviceName: printerName }, (success, failureReason) => {
            resolve({ success, failureReason });
          });
        });
        if (printResult && printResult.success) {
          addHistoryEntry({
            fileName: tab.title,
            printer: printerName,
            pages: tab.pageCount,
            copies: printOptions.copies
          });
          fs.appendFileSync(PRINT_LOG_PATH, `${new Date().toISOString()} - webContents.print succeeded\n`);
          return { ok: true, advancedWarning, fallback: 'webcontents-print' };
        } else {
          const reason = (printResult && printResult.failureReason) || 'unknown';
          fs.appendFileSync(PRINT_LOG_PATH, `${new Date().toISOString()} - webContents.print failed: ${reason}\n`);
          return { ok: false, error: `pdf-to-printer failed: ${errMsg}; webContents.print failed: ${reason}` };
        }
      } catch (e2) {
        fs.appendFileSync(PRINT_LOG_PATH, `${new Date().toISOString()} - webContents.print threw: ${String(e2)}\n`);
        return { ok: false, error: `pdf-to-printer failed: ${errMsg}; fallback error: ${String(e2)}` };
      }
    }
    return { ok: false, error: errMsg };
  }
}

// Diagnostic: list system printers and return statuses
ipcMain.handle('diagnose-printers', async () => {
  try {
    const [printers, statuses] = await Promise.all([getSystemPrinters(), getPrinterStatuses()]);
    return { ok: true, printers: printers.map(p => ({ name: p.name, displayName: p.name, status: statuses[p.name] || 'unknown' })) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

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
ipcMain.handle('toggle-tab-pin', async (event, id) => togglePin(id));
ipcMain.handle('hide-tab', async (event, id) => hideTab(id));
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

// Verbose print for diagnostics: returns full error message and stack if any
ipcMain.handle('verbose-print', async (event, { id, options }) => {
  try {
    const result = await printTab(id, options);
    return { ok: result.ok, result };
  } catch (e) {
    return { ok: false, error: String(e), stack: e && e.stack };
  }
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

// ---------- N-up (pages-per-sheet) preview ----------
// Compose N source pages onto a single A4 page for preview using pdf-lib
async function createNupPreview(filePath, pagesPerSheet, pageRangeText = null) {
  try {
    const buffer = await fs.promises.readFile(filePath);
    const srcDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
    const totalPages = srcDoc.getPageCount();

    // Determine pages to include
    let pagesToInclude = [];
    if (pageRangeText && pageRangeText.trim()) {
      const pages = new Set();
      for (const part of pageRangeText.split(',')) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        if (trimmed.includes('-')) {
          const [start, end] = trimmed.split('-').map(s => parseInt(s.trim(), 10));
          for (let i = start; i <= end && i <= totalPages; i++) pages.add(i - 1);
        } else {
          const page = parseInt(trimmed, 10);
          if (page > 0 && page <= totalPages) pages.add(page - 1);
        }
      }
      pagesToInclude = Array.from(pages).sort((a,b) => a-b);
    } else {
      pagesToInclude = Array.from({length: totalPages}, (_,i) => i);
    }

    if (pagesToInclude.length === 0) return null;

    // Guard for very large docs — avoid composing thousands of pages into memory
    const MAX_PREVIEW_PAGES = 500; // configurable
    if (pagesToInclude.length > MAX_PREVIEW_PAGES) {
      // Signal caller that document is too large for N-up preview
      return { error: 'too_large', totalPages };
    }

    const newDoc = await PDFDocument.create();

    // A4 dimensions in points (72 DPI): 595 x 842
    const PAGE_WIDTH = 595;
    const PAGE_HEIGHT = 842;

    // Grid for pagesPerSheet: support 1,2,4,6,9,16
    const gridMap = {
      1: [1,1],
      2: [2,1],
      4: [2,2],
      6: [3,2],
      9: [3,3],
      16: [4,4]
    };
    const grid = gridMap[pagesPerSheet] || [1,1];
    const cols = grid[0], rows = grid[1];

    const slotWidth = PAGE_WIDTH / cols;
    const slotHeight = PAGE_HEIGHT / rows;

    // Copy pages we need into the new doc as embedded pages
    const srcPages = await newDoc.copyPages(srcDoc, pagesToInclude);

    // Create pages grouping
    for (let i = 0; i < srcPages.length; i += cols*rows) {
      const page = newDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      const chunk = srcPages.slice(i, i + cols*rows);
      for (let j = 0; j < chunk.length; j++) {
        const srcPage = chunk[j];
        // Calculate position
        const col = j % cols;
        const row = Math.floor(j / cols);
        const x = col * slotWidth;
        const y = PAGE_HEIGHT - (row + 1) * slotHeight; // PDF origin bottom-left

        // Embed the page as XObject and draw scaled to fit slot while preserving aspect
        const embedded = await newDoc.embedPage(srcPage);
        const { width: sw, height: sh } = embedded.scale(1);
        const xScale = Math.min(slotWidth / sw, slotHeight / sh);
        const drawWidth = sw * xScale;
        const drawHeight = sh * xScale;
        const dx = x + (slotWidth - drawWidth) / 2;
        const dy = y + (slotHeight - drawHeight) / 2;
        page.drawPage(embedded, { x: dx, y: dy, xScale: xScale, yScale: xScale });
      }
    }

    const outBuffer = await newDoc.save();
    const tempPath = path.join(os.tmpdir(), `print-shop-nup-${Date.now()}-${pagesPerSheet}.pdf`);
    await fs.promises.writeFile(tempPath, outBuffer);
    return tempPath;
  } catch (e) {
    console.error('Error creating n-up preview:', e);
    return null;
  }
}

ipcMain.handle('create-nup-preview', async (event, { filePath, pagesPerSheet, pageRangeText }) => {
  if (!filePath) return { ok: false, error: 'No file' };
  const result = await createNupPreview(filePath, parseInt(pagesPerSheet,10) || 1, pageRangeText || null);
  if (!result) return { ok: false, error: 'Failed to create n-up preview' };
  if (result.error === 'too_large') return { ok: false, error: 'too_large', totalPages: result.totalPages };
  return { ok: true, path: result };
});

ipcMain.handle('load-pdf-in-active-tab', async (event, { filePath }) => {
  if (!activeTabId) return { ok: false, error: 'No active tab' };
  const tab = tabs.get(activeTabId);
  if (!tab) return { ok: false, error: 'Tab not found' };

  // Update the logical filePath for this tab so printing uses the shown document
  tab.filePath = filePath;
  tab.isPreview = true;

  const fileUrl = `file:///${filePath.replace(/\\/g, '/')}`;
  try {
    if (!tab.view) {
      // Create a view if none (lazy) to show the preview
      const view = new BrowserView({ webPreferences: { plugins: true, contextIsolation: true, backgroundThrottling: true } });
      tab.view = view;
      mainWindow.addBrowserView(view);
      layoutActiveView();
    }
    await tab.view.webContents.loadURL(fileUrl);
  } catch (e) {
    console.error('Failed to load PDF in active tab:', e);
    return { ok: false, error: String(e) };
  }
  broadcastTabs();
  return { ok: true };
});

ipcMain.handle('load-original-in-active-tab', async () => {
  if (!activeTabId) return { ok: false, error: 'No active tab' };
  const tab = tabs.get(activeTabId);
  if (!tab) return { ok: false, error: 'Tab not found' };
  if (!tab.originalFilePath) return { ok: false, error: 'No original file saved' };
  tab.filePath = tab.originalFilePath;
  tab.isPreview = false;
  const fileUrl = `file:///${tab.filePath.replace(/\\/g, '/')}`;
  try {
    if (!tab.view) {
      const view = new BrowserView({ webPreferences: { plugins: true, contextIsolation: true, backgroundThrottling: true } });
      tab.view = view;
      mainWindow.addBrowserView(view);
      layoutActiveView();
    }
    await tab.view.webContents.loadURL(fileUrl);
  } catch (e) {
    console.error('Failed to load original PDF in active tab:', e);
    return { ok: false, error: String(e) };
  }
  broadcastTabs();
  return { ok: true };
});

app.whenReady().then(createMainWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});
