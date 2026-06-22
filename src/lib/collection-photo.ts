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
