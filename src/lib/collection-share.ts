export const COLLECTION_SHARE_VERSION = "20260622-2";

export function normalizeCollectionShareToken(token?: string | null) {
  return (
    String(token ?? "")
      .replace(/[^a-z0-9-]/gi, "")
      .slice(0, 32) || COLLECTION_SHARE_VERSION
  );
}

export function collectionSharePath(slug: string, token?: string | null) {
  // A collection has one durable public address. Poster cache busting belongs
  // on the image URL, not on a new share URL every time the owner edits it.
  void token;
  return `/collection/${slug}`;
}

export function collectionPosterPath(slug: string, token?: string | null) {
  return `/api/collection-poster/${slug}?v=${normalizeCollectionShareToken(token)}`;
}
