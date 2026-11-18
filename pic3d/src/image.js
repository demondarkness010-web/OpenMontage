// Decode a user image into (a) a texture canvas and (b) a smaller ImageData for the
// depth model. Uses <img> decoding so EXIF orientation, AVIF, SVG and GIF all work.

const TEXTURE_MAX = 2048;
const DEPTH_MAX = 1024;

/**
 * @param {Blob} blob
 * @param {string} name
 */
export async function loadImage(blob, name = 'image') {
  if (blob.type && !blob.type.startsWith('image/')) {
    throw new Error(`"${name}" is not an image file.`);
  }
  const url = URL.createObjectURL(blob);
  const img = new Image();
  // onload rather than img.decode(): decode() can stall while the tab is hidden.
  const loaded = new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
  });
  img.src = url;
  try {
    await loaded;
  } catch {
    URL.revokeObjectURL(url);
    throw new Error(`Couldn't read "${name}". Try a JPG, PNG, WebP or AVIF.`);
  }
  const width = img.naturalWidth || 1024;
  const height = img.naturalHeight || 1024;

  const texture = draw(img, width, height, TEXTURE_MAX);
  const depthCanvas = draw(img, width, height, DEPTH_MAX);
  const depthInput = depthCanvas.getContext('2d').getImageData(0, 0, depthCanvas.width, depthCanvas.height);

  return { name, url, width, height, aspect: width / height, texture, depthInput };
}

function draw(img, w, h, max) {
  const s = Math.min(1, max / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * s));
  canvas.height = Math.max(1, Math.round(h * s));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

export function baseName(name) {
  return (name.replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || 'relief').slice(0, 60);
}
