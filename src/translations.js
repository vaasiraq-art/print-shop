// Turkish and German are not fully translated yet — they intentionally fall
// back to English below rather than shipping incorrect/partial strings.
const TRANSLATIONS = {
  en: {
    dropHint: 'Drop PDF files here or click +',
    printer: 'Printer',
    pages: 'Pages',
    all: 'All',
    custom: 'Custom',
    copies: 'Copies',
    color: 'Color',
    colorOpt: 'Color',
    bwOpt: 'Black & white',
    none: '— None —',
    more: 'More',
    totalPages: 'Total pages',
    print: 'Print',
    printAll: 'Print all',
    paperSize: 'Paper size',
    pagesPerSheet: 'Pages per sheet',
    quality: 'Quality',
    scale: 'Scale',
    duplex: 'Print on both sides',
    flipLong: 'Flip on long edge',
    flipShort: 'Flip on short edge',
    emptyHint: 'Open a PDF to get started',
    openPdf: 'Open PDF',
    duplicateTab: 'Duplicate tab',
    lockTab: 'Lock tab',
    unlockTab: 'Unlock tab',
    closeTab: 'Close tab',
    printHistory: 'Print history',
    clearHistory: 'Clear history',
    savePreset: 'Save a new print preset',
    cancel: 'Cancel',
    save: 'Save',
    confirmPrint: 'Confirm print',
    notSupported: 'Not available in silent print mode',
    printerReady: 'Ready',
    printerBusy: 'Busy',
    printerOffline: 'Offline',
    printerUnknown: 'Unknown',
    qualityAuto: 'Automatic',
    qualityDraft: 'Draft (~150dpi, economical)',
    qualityHigh: 'High (~600-1200dpi)',
    adminNote: '⚠️ Pages-per-sheet and Quality require running as Administrator',
    advancedConfigWarning:
      "Pages-per-sheet/Quality didn't apply — run the app as Administrator, or this printer's driver may not support it. The rest of the print settings still went through."
  },
  ar: {
    dropHint: 'اسحب ملفات PDF هنا أو اضغط +',
    printer: 'الطابعة',
    pages: 'الصفحات',
    all: 'الكل',
    custom: 'مخصص',
    copies: 'نسخ',
    color: 'اللون',
    colorOpt: 'ملون',
    bwOpt: 'أبيض وأسود',
    none: '— بدون —',
    more: 'المزيد',
    totalPages: 'إجمالي الصفحات',
    print: 'طباعة',
    printAll: 'طباعة الكل',
    paperSize: 'حجم الورق',
    pagesPerSheet: 'صفحات لكل ورقة',
    quality: 'الجودة',
    scale: 'المقياس',
    duplex: 'طباعة على الوجهين',
    flipLong: 'الطي على الحافة الطويلة',
    flipShort: 'الطي على الحافة القصيرة',
    emptyHint: 'افتح ملف PDF للبدء',
    openPdf: 'فتح ملف PDF',
    duplicateTab: 'نسخ التبويب',
    lockTab: 'قفل التبويب',
    unlockTab: 'فتح قفل التبويب',
    closeTab: 'إغلاق التبويب',
    printHistory: 'سجل الطباعة',
    clearHistory: 'مسح السجل',
    savePreset: 'حفظ إعداد طباعة جديد',
    cancel: 'إلغاء',
    save: 'حفظ',
    confirmPrint: 'تأكيد الطباعة',
    notSupported: 'غير متوفر بوضع الطباعة الصامتة',
    printerReady: 'جاهزة',
    printerBusy: 'مشغولة',
    printerOffline: 'غير متصلة',
    printerUnknown: 'غير معروف',
    qualityAuto: 'تلقائي',
    qualityDraft: 'مسودة اقتصادية (~150dpi)',
    qualityHigh: 'جودة عالية (~600-1200dpi)',
    adminNote: '⚠️ صفحات لكل ورقة والجودة تحتاج تشغيل البرنامج كـ Administrator',
    advancedConfigWarning:
      'صفحات لكل ورقة/الجودة ما انطبقت — شغّل البرنامج كـ Administrator، أو درايفر هاي الطابعة ما يدعمها. باقي إعدادات الطباعة انطبقت عادي.'
  }
};

function applyTranslations(lang) {
  const dict = TRANSLATIONS[lang] || TRANSLATIONS.en;
  document.documentElement.setAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
  document.documentElement.setAttribute('lang', lang);
  document.querySelectorAll('[data-i18n]').forEach((elText) => {
    const key = elText.getAttribute('data-i18n');
    if (dict[key]) elText.textContent = dict[key];
  });
  document.querySelectorAll('[data-i18n-title]').forEach((elText) => {
    const key = elText.getAttribute('data-i18n-title');
    if (dict[key]) elText.setAttribute('title', dict[key]);
  });
}
