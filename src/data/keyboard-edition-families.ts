export interface KeyboardEditionFamily {
  familyName: string;
  searchQuery: string;
  slugs: string[];
}

const KEYBOARD_EDITION_FAMILIES: KeyboardEditionFamily[] = [
  {
    familyName: "TGR Jane v2",
    searchQuery: "TGR Jane v2",
    slugs: ["gh-97552", "gh-100415", "tgr-jane-v2-me"],
  },
];

export function getKeyboardEditionFamily(
  slug: string
): KeyboardEditionFamily | null {
  return (
    KEYBOARD_EDITION_FAMILIES.find((family) => family.slugs.includes(slug)) ??
    null
  );
}
