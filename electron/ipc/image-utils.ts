import { spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { nativeImage } from 'electron'
import { getPythonPath } from '../python-backend'
import { logger } from '../logger'

const DEFAULT_THUMBNAIL_MAX_DIMENSION = 400

/**
 * Whether the interpreter we'd shell out to actually has Pillow.
 *
 * Thumbnails and image dimensions are computed by a Python one-liner, which assumes this
 * machine has the backend's environment. A client driving a *remote* backend has no reason
 * to — that is the point of it — so on such a machine every asset import used to die with
 * `ModuleNotFoundError: No module named 'PIL'`, and the generated video was discarded over
 * a failed preview.
 *
 * Probed once and cached: the answer cannot change within a run, and retrying per asset
 * costs a doomed subprocess each time.
 */
let pillowAvailable: boolean | null = null

function hasPillow(): boolean {
  if (pillowAvailable !== null) return pillowAvailable
  const result = spawnSync(getPythonPath(), ['-c', 'import PIL'], { timeout: 10000 })
  pillowAvailable = result.status === 0
  if (!pillowAvailable) {
    logger.info('[image-utils] Pillow unavailable; using Electron nativeImage for thumbnails')
  }
  return pillowAvailable
}

/**
 * Electron's own image pipeline. No subprocess and no dependency, so it works on a machine
 * that has nothing installed but the app.
 *
 * It does not apply EXIF orientation, which Pillow's `exif_transpose` does — so Pillow
 * stays the preferred path when it exists, and this is the fallback rather than the
 * replacement. Generated frames come from ffmpeg as PNGs with no EXIF, so the common case
 * here is unaffected; a sideways phone photo imported on a Pillow-less machine is the known
 * limit.
 */
function resizeWithNativeImage(sourcePath: string, outputPath: string, maxDimension: number): void {
  const image = nativeImage.createFromPath(sourcePath)
  if (image.isEmpty()) {
    throw new Error(`Could not read image for thumbnailing: ${sourcePath}`)
  }
  const { width, height } = image.getSize()
  const scale = Math.min(maxDimension / width, maxDimension / height, 1)
  const resized = scale < 1
    ? image.resize({
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
        quality: 'best',
      })
    : image
  fs.writeFileSync(outputPath, resized.toPNG())
}

export function getThumbnailPaths(assetPath: string): { bigThumbnailPath: string; smallThumbnailPath: string } {
  const parsed = path.parse(assetPath)
  return {
    bigThumbnailPath: path.join(parsed.dir, `${parsed.name}_big_thumbnail.png`),
    smallThumbnailPath: path.join(parsed.dir, `${parsed.name}_small_thumbnail.png`),
  }
}

export function createDownsampledThumbnail(
  sourcePath: string,
  outputPath: string,
  maxDimension = DEFAULT_THUMBNAIL_MAX_DIMENSION,
): void {
  if (!hasPillow()) {
    resizeWithNativeImage(sourcePath, outputPath, maxDimension)
    return
  }

  const pythonPath = getPythonPath()
  const script = [
    'from PIL import Image, ImageOps',
    'import sys',
    '',
    'src = sys.argv[1]',
    'dst = sys.argv[2]',
    'max_dim = int(sys.argv[3])',
    '',
    'with Image.open(src) as img:',
    '    img = ImageOps.exif_transpose(img)',
    '    img.thumbnail((max_dim, max_dim), Image.Resampling.LANCZOS)',
    '    if img.mode not in ("RGB", "RGBA"):',
    '        img = img.convert("RGBA" if "A" in img.getbands() else "RGB")',
    '    img.save(dst, format="PNG")',
  ].join('\n')
  const result = spawnSync(
    pythonPath,
    ['-c', script, sourcePath, outputPath, String(maxDimension)],
    { timeout: 15000 },
  )
  if (result.status !== 0) {
    const stderr = result.stderr?.toString().trim() || ''
    throw new Error(`Pillow resize failed (code ${result.status}): ${stderr}`)
  }
  if (!fs.existsSync(outputPath)) {
    throw new Error(`Failed to create small thumbnail: ${outputPath}`)
  }
}

export function getImageDimensions(sourcePath: string): { width: number; height: number } {
  if (!hasPillow()) {
    const image = nativeImage.createFromPath(sourcePath)
    if (image.isEmpty()) {
      throw new Error(`Could not read image dimensions: ${sourcePath}`)
    }
    return image.getSize()
  }

  const pythonPath = getPythonPath()
  const script = [
    'from PIL import Image, ImageOps',
    'import sys',
    '',
    'src = sys.argv[1]',
    '',
    'with Image.open(src) as img:',
    '    img = ImageOps.exif_transpose(img)',
    '    print(f"{img.width},{img.height}")',
  ].join('\n')
  const result = spawnSync(
    pythonPath,
    ['-c', script, sourcePath],
    { encoding: 'utf8', timeout: 10000 },
  )
  if (result.status !== 0) {
    const stderr = result.stderr?.toString().trim() || ''
    throw new Error(`Pillow dimension probe failed (code ${result.status}): ${stderr}`)
  }

  const [widthText, heightText] = (result.stdout || '').trim().split(',')
  const width = Number(widthText)
  const height = Number(heightText)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid image dimensions for ${sourcePath}: ${(result.stdout || '').trim()}`)
  }

  return { width, height }
}
