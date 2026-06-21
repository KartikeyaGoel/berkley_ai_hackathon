import sharp from "sharp";

export const DIFF_THRESHOLD = 15 / 255;

const GRID_SIZE = 10;
const DIFF_SIZE = 200;
const MAX_LONG_EDGE = 1568;
const BBOX_PAD_RATIO = 0.1;

export interface DiffResult {
  crop: Buffer;
  fullImage: Buffer;
  changed: boolean;
  bbox: { x0: number; y0: number; x1: number; y1: number } | null;
  imageBytesSent: number;
  imageBytesUncropped: number;
  /** Dimensions of the normalized full frame (for bbox→grid mapping). */
  imageWidth: number;
  imageHeight: number;
}

/** Anthropic vision token estimate: tokens ≈ (w × h) / 750. */
export function estimateImageTokens(width: number, height: number): number {
  if (width <= 0 || height <= 0) return 0;
  return Math.ceil((width * height) / 750);
}

async function resizeLongEdge(buffer: Buffer, maxEdge: number): Promise<Buffer> {
  const meta = await sharp(buffer).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width === 0 || height === 0) {
    throw new Error("Invalid image dimensions");
  }
  const longEdge = Math.max(width, height);
  if (longEdge <= maxEdge) {
    return sharp(buffer).jpeg({ quality: 85 }).toBuffer();
  }
  const scale = maxEdge / longEdge;
  const newWidth = Math.round(width * scale);
  const newHeight = Math.round(height * scale);
  return sharp(buffer)
    .resize(newWidth, newHeight, { fit: "inside" })
    .jpeg({ quality: 85 })
    .toBuffer();
}

function blockMeanDiff(
  newPixels: Buffer,
  prevPixels: Buffer,
  blockX: number,
  blockY: number,
  blockW: number,
  blockH: number,
  imageW: number,
): number {
  let sum = 0;
  let count = 0;
  const startX = blockX * blockW;
  const startY = blockY * blockH;
  const endX = Math.min(startX + blockW, imageW);
  const endY = Math.min(startY + blockH, DIFF_SIZE);

  for (let y = startY; y < endY; y++) {
    for (let x = startX; x < endX; x++) {
      const idx = y * imageW + x;
      sum += Math.abs(newPixels[idx]! - prevPixels[idx]!);
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
}

export async function diffAndCrop(
  newImageBuffer: Buffer,
  prevImageBuffer: Buffer | null,
): Promise<DiffResult> {
  const normalizedNew = await resizeLongEdge(newImageBuffer, MAX_LONG_EDGE);
  const uncroppedBytes = normalizedNew.length;
  const newMeta = await sharp(normalizedNew).metadata();
  const imageWidth = newMeta.width ?? 0;
  const imageHeight = newMeta.height ?? 0;

  if (!prevImageBuffer) {
    return {
      crop: normalizedNew,
      fullImage: normalizedNew,
      changed: true,
      bbox: null,
      imageBytesSent: uncroppedBytes,
      imageBytesUncropped: uncroppedBytes,
      imageWidth,
      imageHeight,
    };
  }

  const normalizedPrev = await resizeLongEdge(prevImageBuffer, MAX_LONG_EDGE);

  const newRaw = await sharp(normalizedNew)
    .resize(DIFF_SIZE, DIFF_SIZE, { fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer();

  const prevRaw = await sharp(normalizedPrev)
    .resize(DIFF_SIZE, DIFF_SIZE, { fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer();

  const blockW = DIFF_SIZE / GRID_SIZE;
  const blockH = DIFF_SIZE / GRID_SIZE;
  const changedBlocks: { bx: number; by: number }[] = [];

  for (let by = 0; by < GRID_SIZE; by++) {
    for (let bx = 0; bx < GRID_SIZE; bx++) {
      const meanDiff = blockMeanDiff(newRaw, prevRaw, bx, by, blockW, blockH, DIFF_SIZE);
      if (meanDiff > DIFF_THRESHOLD) {
        changedBlocks.push({ bx, by });
      }
    }
  }

  if (changedBlocks.length === 0) {
    return {
      crop: normalizedNew,
      fullImage: normalizedNew,
      changed: false,
      bbox: null,
      imageBytesSent: 0,
      imageBytesUncropped: uncroppedBytes,
      imageWidth,
      imageHeight,
    };
  }

  const origW = imageWidth || DIFF_SIZE;
  const origH = imageHeight || DIFF_SIZE;

  let x0 = origW;
  let y0 = origH;
  let x1 = 0;
  let y1 = 0;

  for (const { bx, by } of changedBlocks) {
    x0 = Math.min(x0, Math.floor((bx * origW) / GRID_SIZE));
    y0 = Math.min(y0, Math.floor((by * origH) / GRID_SIZE));
    x1 = Math.max(x1, Math.ceil(((bx + 1) * origW) / GRID_SIZE));
    y1 = Math.max(y1, Math.ceil(((by + 1) * origH) / GRID_SIZE));
  }

  const padX = Math.round((x1 - x0) * BBOX_PAD_RATIO);
  const padY = Math.round((y1 - y0) * BBOX_PAD_RATIO);
  x0 = Math.max(0, x0 - padX);
  y0 = Math.max(0, y0 - padY);
  x1 = Math.min(origW, x1 + padX);
  y1 = Math.min(origH, y1 + padY);

  const width = x1 - x0;
  const height = y1 - y0;

  const cropped = await sharp(normalizedNew)
    .extract({ left: x0, top: y0, width, height })
    .jpeg({ quality: 85 })
    .toBuffer();

  return {
    crop: cropped,
    fullImage: normalizedNew,
    changed: true,
    bbox: { x0, y0, x1, y1 },
    imageBytesSent: cropped.length,
    imageBytesUncropped: uncroppedBytes,
    imageWidth,
    imageHeight,
  };
}
