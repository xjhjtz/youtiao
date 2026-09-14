/**
 * image.js —— 浏览器端图片读取与可选压缩。
 *
 * 默认不处理图片（原样提交），只有用户显式勾选「压缩 / 转 WebP」才会走 canvas 重编码。
 * 这符合需求：图床只负责「邮箱 → SHA-256 → 存进 GitHub」。
 */

/** 是否像一张图片。 */
export function isImageFile(file) {
  if (!file) return false;
  if (file.type && file.type.startsWith('image/')) return true;
  return /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico|tiff?|heic|heif)$/i.test(file.name || '');
}

/** File → base64（不带 data: 前缀），用 FileReader 以免大图撑爆内存字符串。 */
export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.onerror = () => reject(new Error(`读取文件失败：${file && file.name}`));
    reader.readAsDataURL(file);
  });
}

/** File → ArrayBuffer。 */
export function fileToArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(`读取文件失败：${file && file.name}`));
    reader.readAsArrayBuffer(file);
  });
}

/** 加载成 HTMLImageElement（用于压缩与尺寸探测）。 */
export function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`无法解析图片：${file && file.name}`));
    };
    img.src = url;
  });
}

/** 计算缩放后的尺寸（只缩不放）。 */
export function fitSize(width, height, maxEdge) {
  const edge = Math.max(1, Number(maxEdge) || 0);
  if (!edge || (width <= edge && height <= edge)) return { width, height, scaled: false };
  const ratio = width >= height ? edge / width : edge / height;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
    scaled: true
  };
}

/**
 * 可选压缩：等比缩放到 maxEdge，并按需转成 webp / jpeg / png。
 * @param {File} file
 * @param {{maxEdge?:number, format?:'original'|'webp'|'jpeg'|'png', quality?:number}} options
 * @returns {Promise<{blob:Blob, width:number, height:number, type:string, scaled:boolean}>}
 */
export async function compressImage(file, options = {}) {
  const maxEdge = Number(options.maxEdge) || 512;
  const quality = Math.min(1, Math.max(0.1, Number(options.quality) || 0.9));
  let format = options.format || 'original';

  const img = await loadImage(file);
  const { width, height, scaled } = fitSize(img.naturalWidth, img.naturalHeight, maxEdge);

  // SVG / GIF（动图）交给浏览器直接处理没有意义，原样返回
  if (/svg|gif/i.test(file.type || '')) {
    return { blob: file, width: img.naturalWidth, height: img.naturalHeight, type: file.type, scaled: false, passthrough: true };
  }

  if (format === 'original') {
    const ext = (file.type && file.type.split('/')[1]) || '';
    if (ext === 'jpeg' || ext === 'jpg') format = 'jpeg';
    else if (ext === 'webp') format = 'webp';
    else format = 'png';
  }

  if (!scaled && format === 'original') {
    return { blob: file, width: img.naturalWidth, height: img.naturalHeight, type: file.type, scaled: false, passthrough: true };
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('当前浏览器不支持 Canvas，无法压缩图片');
  // JPEG 没有透明通道，先铺白底，避免透明区域变黑
  if (format === 'jpeg') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
  }
  ctx.drawImage(img, 0, 0, width, height);

  const mime = `image/${format}`;
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, mime, quality));
  if (!blob) throw new Error('图片压缩失败（canvas.toBlob 返回空）');

  return { blob, width, height, type: mime, scaled, passthrough: false };
}

/** Blob → base64。 */
export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.onerror = () => reject(new Error('读取压缩结果失败'));
    reader.readAsDataURL(blob);
  });
}

/** 下载一个 URL（用于「下载原图」，走 CDN 拿到 blob 再存盘）。 */
export async function downloadUrl(url, fileName) {
  const response = await fetch(url, { mode: 'cors' });
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
  const blob = await response.blob();
  triggerDownload(blob, fileName);
}

/** 触发浏览器下载。 */
export function triggerDownload(blobOrText, fileName, mime = 'application/octet-stream') {
  const blob = blobOrText instanceof Blob ? blobOrText : new Blob([blobOrText], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** 由 base64 还原成可下载的 Blob（用于「下载仓库里的原图」）。 */
export function base64ToBlob(base64, type = 'application/octet-stream') {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}

/** 用图片内容的魔数猜 MIME —— 无扩展名文件在有的浏览器里会下载成 .bin。 */
export function sniffImageType(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const startsWith = (...sig) => sig.every((v, i) => b[i] === v);
  if (startsWith(0x89, 0x50, 0x4e, 0x47)) return { mime: 'image/png', ext: 'png' };
  if (startsWith(0xff, 0xd8, 0xff)) return { mime: 'image/jpeg', ext: 'jpg' };
  if (startsWith(0x47, 0x49, 0x46, 0x38)) return { mime: 'image/gif', ext: 'gif' };
  if (startsWith(0x52, 0x49, 0x46, 0x46) && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    return { mime: 'image/webp', ext: 'webp' };
  }
  if (startsWith(0x42, 0x4d)) return { mime: 'image/bmp', ext: 'bmp' };
  if (startsWith(0x00, 0x00, 0x01, 0x00)) return { mime: 'image/x-icon', ext: 'ico' };
  const head = new TextDecoder().decode(b.slice(0, 200)).trim().toLowerCase();
  if (head.startsWith('<svg') || head.startsWith('<?xml')) return { mime: 'image/svg+xml', ext: 'svg' };
  return { mime: 'application/octet-stream', ext: 'bin' };
}
