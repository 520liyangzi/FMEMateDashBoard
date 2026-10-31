type Language = 'zh' | 'en';
type MutableSnapshot = Record<string, unknown> & {
  demo?: boolean;
  lang?: Language;
  state?: Record<string, unknown> & {
    feedback?: (Record<string, unknown> & { imageUrl?: string })[];
    siteVisits?: {photos:string[]}[];
  };
};

const message = (lang: Language, zh: string, en: string) => lang === 'zh' ? zh : en;

function verifyAssets(js: string, css: string, lang: Language) {
  if (!js.trim() || !css.trim()) {
    throw new Error(message(lang, '离线报表资源不完整，请先完成项目构建后重试。', 'Offline report assets are incomplete. Build the project, then try again.'));
  }
  // The production entry must be one fully bundled module. A file:// report
  // cannot resolve application chunks or external module URLs.
  const imports = /(?:^|[;\n])\s*import\s*(?:["'{*]|[\w$]+\s*(?:,|\s+from\b))/m;
  const dynamicImports = /\bimport\s*\(/;
  if (imports.test(js) || dynamicImports.test(js) || /@import\s*(?:url\s*\(|["'])/i.test(css)) {
    throw new Error(message(lang, '报表资源仍依赖其他文件，请以单文件打包方式重新构建后再导出。', 'The report assets still depend on other files. Rebuild with a single JavaScript bundle before exporting.'));
  }
}

/** Exported separately so the inline-document boundary can be verified without a browser. */
export function createOfflineDocument(snapshot: unknown, lang: Language, js: string, css: string): string {
  verifyAssets(js, css, lang);
  const serialized = JSON.stringify(snapshot);
  if (serialized === undefined) throw new Error(message(lang, '报表数据为空，无法导出。', 'There is no report data to export.'));
  const data = serialized.replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const inlineJs = js
    .replace(/<\/script/gi, match => `<\\/${match.slice(2)}`)
    .replace(/\/\/# sourceMappingURL=[^\r\n]*/g, '');
  const inlineCss = css
    .replace(/<\/style/gi, match => `\\3C /${match.slice(2)}`)
    .replace(/\/\*# sourceMappingURL=[\s\S]*?\*\//g, '');
  const title = lang === 'zh' ? 'FMEMate 项目进展 · 离线报表' : 'FMEMate Project Pulse · Offline Report';
  return `<!doctype html>
<html lang="${lang === 'zh' ? 'zh-CN' : 'en'}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="referrer" content="no-referrer">
<title>${title}</title>
<style>${inlineCss}</style>
</head>
<body>
<div id="root"></div>
<script>window.__PULSE_OFFLINE__=${data};</script>
<script type="module">${inlineJs}</script>
</body>
</html>`;
}

function asDataUri(blob: Blob, lang: Language): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const fail = () => reject(new Error(message(lang, '无法读取报表图片，离线报表尚未生成。', 'A report image could not be read. The offline report was not generated.')));
    reader.onload = () => typeof reader.result === 'string' && reader.result.startsWith('data:') ? resolve(reader.result) : fail();
    reader.onerror = fail;
    reader.onabort = fail;
    reader.readAsDataURL(blob);
  });
}

/** Downloads a standalone, data-complete report. It never changes the live state. */
export async function downloadOfflineReport(snapshot: unknown, lang: Language): Promise<void> {
  if ('__PULSE_OFFLINE__' in window) {
    throw new Error(message(lang, '当前已是离线报表，请返回运行中的网页导出新的报表。', 'This is already an offline report. Return to the running app to export a new one.'));
  }
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error(message(lang, '报表数据格式无效，无法导出。', 'The report data is invalid and cannot be exported.'));
  }
  // JSON data is the durable report format. This also copies nested feedback
  // records so embedding images never replaces URLs in the live application.
  const copy: MutableSnapshot = JSON.parse(JSON.stringify(snapshot));
  copy.lang = lang;
  const response = await fetch('/api/offline-assets', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(message(lang, '无法读取离线报表资源，请先完成项目构建后重试。', 'Offline report assets are unavailable. Build the project, then try again.'));
  }
  let assets: { js?: unknown; css?: unknown };
  try { assets = await response.json(); }
  catch { throw new Error(message(lang, '离线报表资源格式无效，请重新构建项目。', 'Offline report assets are invalid. Rebuild the project.')); }
  if (typeof assets.js !== 'string' || typeof assets.css !== 'string') {
    throw new Error(message(lang, '离线报表资源缺失，请重新构建项目。', 'Offline report assets are missing. Rebuild the project.'));
  }
  verifyAssets(assets.js, assets.css, lang);

  if (copy.demo && copy.state) {
    // A synthetic preview must never carry production screenshots into a file.
    copy.state.feedback = [];
    copy.state.siteVisits = [];
    copy.state.failureNotes = {};
    copy.state.aiReports = [];
    copy.state.aiReportsTotal = 0;
    copy.state.dailySummaries = [];
  } else {
    const feedback = Array.isArray(copy.state?.feedback) ? copy.state.feedback : [];
    const loaded = new Map<string, Promise<string>>();
    const loadImage = (url: string) => {
      if (!loaded.has(url)) loaded.set(url, (async () => {
        let image: Response;
        try { image = await fetch(url, { cache: 'no-store' }); }
        catch { throw new Error(message(lang, '报表图片下载失败，离线报表尚未生成，请重试。', 'A report image could not be downloaded. No offline report was generated. Please try again.')); }
        if (!image.ok) {
          throw new Error(message(lang, '报表图片无法读取，离线报表尚未生成。请确认截图仍可正常打开。', 'A report image is unavailable. No offline report was generated. Check that the screenshot can still be opened.'));
        }
        const blob = await image.blob();
        if (!blob.size || (blob.type && !blob.type.startsWith('image/'))) {
          throw new Error(message(lang, '报表图片内容无效，离线报表尚未生成。', 'A report image is invalid. No offline report was generated.'));
        }
        return asDataUri(blob, lang);
      })());
      return loaded.get(url)!;
    };
    const photoEntries = [...feedback];
    for (const visit of copy.state?.siteVisits ?? []) {
      for (let index = 0; index < visit.photos.length; index++) {
        const url = visit.photos[index];
        photoEntries.push({get imageUrl(){return url},set imageUrl(value:string|undefined){if(value)visit.photos[index]=value}});
      }
    }
    let next = 0;
    const embedImages = async () => {
      while (next < photoEntries.length) {
        const entry = photoEntries[next++];
        const url = entry.imageUrl;
        if (!url) continue;
        if (typeof url !== 'string') throw new Error(message(lang, '报表图片地址无效，无法导出离线报表。', 'A report image URL is invalid. The offline report cannot be exported.'));
        if (url.startsWith('data:image/')) continue;
        if (!url.startsWith('/uploads/')) {
          throw new Error(message(lang, '报表图片不是本地上传文件，无法完整导出离线报表。', 'A report image is not a local upload and cannot be embedded in the offline report.'));
        }
        entry.imageUrl = await loadImage(url);
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, photoEntries.length) }, embedImages));
  }

  const html = createOfflineDocument(copy, lang, assets.js, assets.css);
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const today = new Date();
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `FMEMate_Offline_Report_${date}_${lang}.html`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
