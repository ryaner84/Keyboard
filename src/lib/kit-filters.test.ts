import assert from "node:assert/strict";
import {
  groupBuyHasKit,
  kitFilterLabel,
  normalizeKitFilter,
  type KitFilter,
} from "./kit-filters";

function catalogSet(
  variants: Array<{ title: string; price: number }>,
  nativeType = "BASE"
) {
  return {
    kits: [{ type: nativeType, vendorKits: [{ variants }] }],
  };
}

const mixed = catalogSet([
  { title: "Novelties", price: 35 },
  { title: "Spacebars", price: 29 },
  { title: "Numpad Kit", price: 45 },
  { title: "NorDeUK", price: 39 },
  { title: "Command (macOS)", price: 22 },
]);

for (const filter of ["base", "novelties", "spacebars", "numpad", "iso", "mac"] as KitFilter[]) {
  assert.equal(groupBuyHasKit(mixed, filter), true, `${filter} should match`);
}
assert.equal(groupBuyHasKit(mixed, "alpha"), false);

assert.equal(
  groupBuyHasKit(catalogSet([{ title: "Alpha kit", price: 52 }]), "alpha"),
  true
);
assert.equal(
  groupBuyHasKit(catalogSet([{ title: "Default Title", price: 110 }]), "other"),
  false
);
assert.equal(
  groupBuyHasKit(catalogSet([{ title: "40s extension", price: 40 }]), "other"),
  true
);
assert.equal(groupBuyHasKit(catalogSet([], "NUMPAD"), "numpad"), true);

assert.equal(normalizeKitFilter("NUMPAD"), "numpad");
assert.equal(normalizeKitFilter("unknown"), "");
assert.equal(kitFilterLabel("spacebars"), "Spacebars");

console.log("kit filter tests passed");
