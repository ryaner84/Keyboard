export const COLLECTION_SHARE_VERSION = "20260622-2";

export function collectionSharePath(slug: string) {
  return `/collection/${slug}?share=${COLLECTION_SHARE_VERSION}`;
}

export function collectionPosterPath(slug: string) {
  return `/api/collection-poster/${slug}?v=${COLLECTION_SHARE_VERSION}`;
}
