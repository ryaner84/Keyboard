import "server-only";

const DATA_IMAGE_RE =
  /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/]+={0,2})$/i;
const MAX_DATA_URL_LENGTH = 2_000_000;
const MAX_DECODED_BYTES = 1_500_000;

export function cleanCollectionPhoto(value: unknown): string | null {
  if (value == null) return null;
  const dataUrl = String(value).trim();
  if (!dataUrl) return null;
  if (dataUrl.length > MAX_DATA_URL_LENGTH) return null;

  const match = DATA_IMAGE_RE.exec(dataUrl);
  if (!match) return null;

  const mime = match[1].toLowerCase().replace("jpg", "jpeg");
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length === 0 || bytes.length > MAX_DECODED_BYTES) return null;
  if (!hasMatchingImageSignature(bytes, mime)) return null;

  return dataUrl;
}

function hasMatchingImageSignature(bytes: Buffer, mime: string): boolean {
  if (mime === "jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mime === "png") {
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return bytes.length >= png.length && png.every((value, index) => bytes[index] === value);
  }
  if (mime === "webp") {
    return (
      bytes.length >= 12 &&
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP"
    );
  }
  return false;
}

export function collectionPhotoAtBuild(
  customImageUrl: unknown,
  units: unknown,
  buildIndex: number
): string | null {
  if (buildIndex === 0) return cleanCollectionPhoto(customImageUrl);
  if (!Array.isArray(units)) return null;
  const unit = units[buildIndex - 1];
  if (!unit || typeof unit !== "object") return null;
  return cleanCollectionPhoto((unit as Record<string, unknown>).imageUrl);
}

// `buildIndex` in the report table is deliberately a generic per-record index:
// keyboard entries use it for builds, while keycap entries use it for purchase
// records. Keeping one index preserves the existing report schema and still
// binds reports to the exact uploaded image hash.
export function collectionPhotoAtRecord(
  productType: unknown,
  customImageUrl: unknown,
  units: unknown,
  keycapAcquisitions: unknown,
  recordIndex: number
): string | null {
  if (String(productType).toUpperCase() === "KEYBOARD") {
    return collectionPhotoAtBuild(customImageUrl, units, recordIndex);
  }
  if (!Array.isArray(keycapAcquisitions)) {
    // Older keycap records used the build-one photo slot.
    return recordIndex === 0 ? cleanCollectionPhoto(customImageUrl) : null;
  }
  const acquisition = keycapAcquisitions[recordIndex];
  if (!acquisition || typeof acquisition !== "object") return null;
  const source = acquisition as Record<string, unknown>;
  // A parent set can be public while a particular purchase stays private.
  // Never allow a guessed record index to expose or report that private photo.
  if (source.isPublic === false) return null;
  return source.photoSource === "CUSTOM"
    ? cleanCollectionPhoto(source.imageUrl)
    : null;
}
