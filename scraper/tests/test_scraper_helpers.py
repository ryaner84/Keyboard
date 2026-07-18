from __future__ import annotations

import sys
import unittest
from datetime import datetime
from pathlib import Path


SCRAPER_DIR = Path(__file__).resolve().parents[1]
if str(SCRAPER_DIR) not in sys.path:
    sys.path.insert(0, str(SCRAPER_DIR))

import scrape
from scrapling_client import ScraplingClient, decode_response_body, response_is_blocked


class FakeResponse:
    def __init__(self, body: bytes, *, status: int = 200, encoding: str = "utf-8"):
        self.body = body
        self.status = status
        self.encoding = encoding


class ScraplingClientTests(unittest.TestCase):
    def test_block_detection_uses_status_and_challenge_markers(self):
        self.assertTrue(response_is_blocked(403, "ordinary body"))
        self.assertTrue(response_is_blocked(200, "<title>Just a moment...</title>"))
        self.assertFalse(response_is_blocked(200, "<html><h1>Product</h1></html>"))

    def test_response_body_decoding_is_tolerant(self):
        response = FakeResponse("café".encode("latin-1"), encoding="latin-1")
        self.assertEqual(decode_response_body(response), "café")

    def test_disabled_client_remains_a_safe_noop(self):
        messages: list[str] = []
        with ScraplingClient(
            headless=True,
            logger=messages.append,
            enabled=False,
        ) as client:
            self.assertFalse(client.available)
            self.assertIsNone(client.get_json("https://example.com/data.json"))
        self.assertIn("disabled", messages[0].lower())


class ScraperExtractionTests(unittest.TestCase):
    def test_structured_stock_is_variant_specific(self):
        html = """
        <script type="application/ld+json">
        {
          "@type": "Product",
          "offers": [
            {
              "@type": "Offer",
              "url": "https://shop.test/products/board?variant=100",
              "availability": "https://schema.org/OutOfStock"
            },
            {
              "@type": "Offer",
              "url": "https://shop.test/products/board?variant=200",
              "availability": "https://schema.org/InStock"
            }
          ]
        }
        </script>
        """
        self.assertEqual(
            scrape._structured_variant_stock_from_html(html),
            {"100": False, "200": True},
        )

    def test_catalog_html_parser_handles_relative_links_and_next_page(self):
        html = """
        <a href="/shop/en/gmk-cyl-test/gmk12345">GMK Test</a>
        <a href="/shop/en/gmk-cyl-new/fptk5113.0">GMK New</a>
        <a href="/shop/en/keycaps/">Category</a>
        <link rel="next" href="?p=2">
        """
        products, next_url = scrape._catalog_links_from_html(
            html,
            "https://www.gmk.net/shop/en/keycaps/",
        )
        self.assertEqual(
            products,
            [
                "https://www.gmk.net/shop/en/gmk-cyl-test/gmk12345",
                "https://www.gmk.net/shop/en/gmk-cyl-new/fptk5113.0",
            ],
        )
        self.assertEqual(
            next_url,
            "https://www.gmk.net/shop/en/keycaps/?p=2",
        )

    def test_selected_base_variant_controls_stock(self):
        variants = [
            {"id": "1", "title": "Base Kit", "price": 120},
            {"id": "2", "title": "Deskmat", "price": 20},
        ]
        chosen = variants[0]
        self.assertFalse(
            scrape._base_variants_in_stock(
                variants,
                chosen,
                None,
                {"1": False, "2": True},
            )
        )


class ChooseKitVariantTests(unittest.TestCase):
    def test_prefers_base_over_cheaper_subkits(self):
        variants = [
            {"id": "1", "title": "Novelties", "price": 35},
            {"id": "2", "title": "Base Kit", "price": 135},
            {"id": "3", "title": "Spacebars", "price": 30},
        ]
        self.assertEqual(scrape.choose_kit_variant(variants)["price"], 135)

    def test_single_default_title_variant_is_the_base(self):
        variants = [{"id": "1", "title": "Default Title", "price": 140}]
        self.assertEqual(scrape.choose_kit_variant(variants)["price"], 140)

    def test_listing_with_only_subkits_returns_none(self):
        # Keygem rainy-day-r2 case: the GB listing carries only a cheap novelty
        # and a spacebar kit — no base kit — so no base price must be stored.
        variants = [
            {"id": "1", "title": "GMK Rainy Day Novelties", "price": 38},
            {"id": "2", "title": "GMK Rainy Day Spacebars", "price": 30},
        ]
        self.assertIsNone(scrape.choose_kit_variant(variants))

    def test_unlabeled_base_beats_labeled_subkit(self):
        # Base kit is not literally titled "Base"; the cheap variant is a labeled
        # subkit and must never be chosen over the unlabeled (OTHERS) base.
        variants = [
            {"id": "1", "title": "GMK Monokai Material Alphas", "price": 40},
            {"id": "2", "title": "GMK Monokai Material", "price": 139},
        ]
        chosen = scrape.choose_kit_variant(variants)
        self.assertEqual(chosen["price"], 139)

    def test_addons_are_excluded(self):
        variants = [
            {"id": "1", "title": "Deskmat", "price": 25},
            {"id": "2", "title": "Base Kit", "price": 120},
        ]
        self.assertEqual(scrape.choose_kit_variant(variants)["price"], 120)

    def test_picks_dearest_unlabeled_base_over_unlabeled_subkit(self):
        # NovelKeys gmk-monokai-material: neither variant is titled "base" and
        # the cheap one ("40s") is an unlabeled subkit the classifier reads as
        # OTHERS, so it isn't dropped. Taking the first in display order stored
        # the $40 subkit; the real base is the dearer kit.
        variants = [
            {"id": "1", "title": "GMK Monokai Material 40s", "price": 40},
            {"id": "2", "title": "GMK Monokai Material", "price": 139},
        ]
        self.assertEqual(scrape.choose_kit_variant(variants)["price"], 139)

    def test_dearest_pick_is_order_independent(self):
        # Same listing, base listed first — selection must not depend on order.
        variants = [
            {"id": "1", "title": "GMK Monokai Material", "price": 139},
            {"id": "2", "title": "GMK Monokai Material 40s", "price": 40},
        ]
        self.assertEqual(scrape.choose_kit_variant(variants)["price"], 139)

    def test_numpad_only_listing_returns_none(self):
        # Ktechs gmk-cyl-kitsune: the listing carried only a numpad kit (no
        # base), so the numpad price must not be stored as the base — the
        # picker returns None so the caller clears the stale price (NO_BASE_KIT).
        variants = [{"id": "1", "title": "GMK Kitsune Numpad", "price": 45}]
        self.assertIsNone(scrape.choose_kit_variant(variants))

    def test_numpad_subkit_never_beats_base(self):
        # A real base kit is present alongside the numpad — pick the base.
        variants = [
            {"id": "1", "title": "GMK Kitsune Numpad", "price": 45},
            {"id": "2", "title": "GMK Kitsune", "price": 149},
        ]
        self.assertEqual(scrape.choose_kit_variant(variants)["price"], 149)

    def test_numpad_and_labeled_subkits_only_returns_none(self):
        # numpad ("num pad" spacing) + novelties, no base → nothing to store.
        variants = [
            {"id": "1", "title": "GMK Set Num Pad", "price": 45},
            {"id": "2", "title": "GMK Set Novelties", "price": 38},
        ]
        self.assertIsNone(scrape.choose_kit_variant(variants))

    def test_base_kit_that_bundles_a_numpad_is_still_base(self):
        # A title classified BASE is retained even when it mentions a numpad,
        # so "Base Kit + Numpad" is never dropped by the subkit exclusion.
        variants = [
            {"id": "1", "title": "GMK Set Base Kit + Numpad", "price": 135},
            {"id": "2", "title": "GMK Set Alphas", "price": 40},
        ]
        self.assertEqual(scrape.choose_kit_variant(variants)["price"], 135)

    def test_explicit_base_title_wins_over_a_dearer_other(self):
        # A title-classified BASE is ground truth even when some other OTHERS
        # variant (e.g. a region/bundle line) happens to be priced higher.
        variants = [
            {"id": "1", "title": "GMK Set Base Kit", "price": 120},
            {"id": "2", "title": "GMK Set Region Bundle", "price": 160},
        ]
        self.assertEqual(scrape.choose_kit_variant(variants)["price"], 120)


class GenericStorefrontTests(unittest.TestCase):
    # WooCommerce embeds an HTML-escaped JSON blob of every variation.
    WOO_HTML = (
        '<form class="variations_form cart" data-product_variations="['
        "{&quot;variation_id&quot;:11,&quot;display_price&quot;:101414.29,"
        "&quot;attributes&quot;:{&quot;attribute_kit&quot;:&quot;Alphas&quot;},"
        "&quot;is_in_stock&quot;:true},"
        "{&quot;variation_id&quot;:12,&quot;display_price&quot;:184285.71,"
        "&quot;attributes&quot;:{&quot;attribute_kit&quot;:&quot;Base Kit&quot;},"
        "&quot;is_in_stock&quot;:true}]\"></form>"
    )

    def test_woocommerce_variations_parsed_with_titles_and_prices(self):
        variants = scrape.parse_woocommerce_variations(self.WOO_HTML)
        self.assertEqual(len(variants), 2)
        self.assertEqual(
            {v["title"]: v["price"] for v in variants},
            {"Alphas": 101414.29, "Base Kit": 184285.71},
        )

    def test_woocommerce_base_kit_beats_cheaper_subkit(self):
        # Latamkeys mictlan: stored the ARS 101,414 alpha subkit; the base kit
        # (ARS 184,285) is dearer and is what choose_kit_variant must select.
        variants = scrape.parse_woocommerce_variations(self.WOO_HTML)
        self.assertEqual(scrape.choose_kit_variant(variants)["price"], 184285.71)

    def test_woocommerce_variations_carry_availability(self):
        # Per-variant stock feeds the set page's "Complete the set" dots — it
        # must survive parsing so generic_price can persist it.
        variants = scrape.parse_woocommerce_variations(self.WOO_HTML)
        self.assertTrue(all(isinstance(v.get("available"), bool) for v in variants))

    def test_non_woocommerce_html_yields_no_variations(self):
        self.assertEqual(scrape.parse_woocommerce_variations("<html></html>"), [])

    def test_jsonld_simple_offer_price(self):
        # STACKS-style simple product: one priced offer in JSON-LD.
        html = (
            '<script type="application/ld+json">'
            '{"@type":"Product","offers":{"@type":"Offer","price":"13999.00",'
            '"priceCurrency":"INR","availability":"https://schema.org/InStock"}}'
            "</script>"
        )
        offer = scrape.parse_jsonld_offer(html)
        self.assertEqual(offer["price"], 13999.0)
        self.assertTrue(offer["available"])

    def test_jsonld_out_of_stock_is_flagged(self):
        html = (
            '<script type="application/ld+json">'
            '{"@type":"Product","offers":{"price":"159.00",'
            '"availability":"https://schema.org/OutOfStock"}}</script>'
        )
        self.assertFalse(scrape.parse_jsonld_offer(html)["available"])

    def test_jsonld_returns_none_without_offer(self):
        self.assertIsNone(scrape.parse_jsonld_offer("<html>no ld+json</html>"))


class DiscoveryHelpersTests(unittest.TestCase):
    def test_normalize_drops_tags_status_and_filler(self):
        self.assertEqual(
            scrape.normalize_set_name("GMK Striker R2 [GB] Keycap Set (Pre-order)"),
            "gmk striker r2",
        )

    def test_normalize_unifies_round_spelling(self):
        self.assertEqual(
            scrape.normalize_set_name("GMK Striker Round 2"),
            scrape.normalize_set_name("GMK Striker R2"),
        )

    def test_normalize_drops_profile_tokens(self):
        # "CYL"/"MTNU" are GMK profile names, not set identity — vendor outlet
        # listings ("[In Stock] GMK CYL Seafarer") must match "GMK Seafarer".
        self.assertEqual(
            scrape.normalize_set_name("[In Stock] GMK CYL Seafarer"),
            scrape.normalize_set_name("GMK Seafarer"),
        )
        self.assertEqual(
            scrape.normalize_set_name("GMK CYL Kitsune Keycaps"),
            "gmk kitsune",
        )
        # The profile token must not merge across brands: MTNU 9009 ≠ GMK 9009.
        self.assertNotEqual(
            scrape.normalize_set_name("MTNU 9009"),
            scrape.normalize_set_name("GMK 9009"),
        )

    def test_outlet_title_matches_tracked_set(self):
        entry = {"status": "IN_STOCK", "gbStart": None}
        by_full = {"gmk seafarer": entry}
        by_base = {"gmk seafarer": [entry]}
        self.assertIs(
            scrape.match_product_to_set(
                "[In Stock] GMK CYL Seafarer", by_full, by_base
            ),
            entry,
        )


class BaseKitIdentificationTests(unittest.TestCase):
    """Regression suite for the base-vs-subkit audit: every case here stored a
    wrong base price (or wrongly cleared a right one) before the fix."""

    def test_japanese_variant_titles_classify(self):
        # The Python scraper is the producer that reaches Yushakobo — without
        # the JP keywords a ノベルティ variant classified OTHERS and could be
        # stored as the base price.
        self.assertEqual(scrape.classify_variant("ベースキット"), "BASE")
        self.assertEqual(scrape.classify_variant("ノベルティ"), "NOVELTIES")
        self.assertEqual(scrape.classify_variant("スペースバー"), "SPACEBARS")
        self.assertEqual(scrape.classify_variant("アルファ"), "ALPHA")

    def test_japanese_subkit_only_listing_clears(self):
        variants = [
            {"id": "1", "title": "ノベルティ", "price": 4800},
            {"id": "2", "title": "スペースバー", "price": 3300},
        ]
        self.assertIsNone(scrape.choose_kit_variant(variants))

    def test_named_nonbase_subkits_do_not_become_the_base(self):
        # Base sold out and delisted; accent + 40s remain. The old picker took
        # the dearest OTHERS (€45 accent) as the base.
        variants = [
            {"id": "1", "title": "GMK Foo Accent Kit", "price": 45},
            {"id": "2", "title": "GMK Foo 40s", "price": 30},
        ]
        self.assertIsNone(scrape.choose_kit_variant(variants))

    def test_legends_variants_are_not_the_base(self):
        for title in ("Hiragana Kit", "Katakana", "NorDe Kit", "ISO Kit",
                      "Extension Kit", "Forties"):
            self.assertIsNone(
                scrape.choose_kit_variant([{"id": "1", "title": title, "price": 55}]),
                title,
            )

    def test_hiragana_base_still_counts_as_base(self):
        variants = [{"id": "1", "title": "Hiragana Base", "price": 120}]
        self.assertEqual(scrape.choose_kit_variant(variants)["price"], 120)

    def test_accessory_only_listing_clears(self):
        # Every variant is an addon: the old fallback readmitted them and
        # stored a deskmat price as the base kit.
        variants = [
            {"id": "1", "title": "GMK Foo Deskmat", "price": 32},
            {"id": "2", "title": "GMK Foo Deskmat XL", "price": 38},
        ]
        self.assertIsNone(scrape.choose_kit_variant(variants))

    def test_base_deposit_variant_never_wins(self):
        variants = [
            {"id": "1", "title": "Base Kit", "price": 110},
            {"id": "2", "title": "Base Kit Deposit", "price": 35},
        ]
        self.assertEqual(scrape.choose_kit_variant(variants)["price"], 110)

    def test_base_novelties_bundle_is_not_the_base(self):
        # A bundle's price is not the standalone base price; a bundle-only
        # listing clears rather than storing the bundle number.
        variants = [{"id": "1", "title": "Base Kit + Novelties Bundle", "price": 155}]
        self.assertIsNone(scrape.choose_kit_variant(variants))

    def test_subkit_product_titles_are_skipped_by_discovery(self):
        for title in ("GMK Foo (Novelties)", "GMK Foo [Spacebars]",
                      "GMK Bento Alphas", "GMK Foo Deskmat",
                      "GMK Lavender x RAMA Artisan Keycap", "GMK Foo Numpad"):
            self.assertIsNotNone(scrape._SUBKIT_PRODUCT_RE.search(title), title)
        # Real base listings must NOT be skipped: extras rounds sell the base,
        # and a set named "... Alpha" (singular) is a set, not an alphas kit.
        for title in ("GMK Foo Extras", "GMK Alpha", "GMK Foo",
                      "[In Stock] GMK CYL Seafarer"):
            self.assertIsNone(scrape._SUBKIT_PRODUCT_RE.search(title), title)

    @staticmethod
    def _jsonld(offers: str) -> str:
        return (
            '<script type="application/ld+json">'
            '{"@type":"Product","offers":[' + offers + "]}"
            "</script>"
        )

    def test_jsonld_multi_offer_without_base_clears(self):
        # Shopware aggregate left with novelties + spacebars: the old Python
        # picker stored the dearest (€39 novelties) as the base nightly.
        html = self._jsonld(
            '{"name":"Novelties","price":"39"},{"name":"Spacebars","price":"29"}'
        )
        self.assertIs(scrape.parse_jsonld_offer(html), scrape.NO_BASE_KIT)

    def test_jsonld_named_base_wins_over_dearer_subkit(self):
        html = self._jsonld(
            '{"name":"Base Kit","price":"120"},{"name":"Novelties","price":"139"}'
        )
        self.assertEqual(scrape.parse_jsonld_offer(html)["price"], 120.0)

    def test_jsonld_single_subkit_offer_clears(self):
        html = self._jsonld('{"name":"Novelties","price":"39"}')
        self.assertIs(scrape.parse_jsonld_offer(html), scrape.NO_BASE_KIT)

    def test_jsonld_single_unnamed_offer_is_the_base(self):
        html = self._jsonld('{"price":"120"}')
        self.assertEqual(scrape.parse_jsonld_offer(html)["price"], 120.0)

    def test_jsonld_bundle_named_base_is_excluded(self):
        # "Base + Novelties Bundle" contains "base" but classifies NOVELTIES —
        # the old \bbase\b test picked the bundle price as the base.
        html = self._jsonld(
            '{"name":"Base Kit + Novelties Bundle","price":"155"},'
            '{"name":"Spacebars","price":"29"}'
        )
        self.assertIs(scrape.parse_jsonld_offer(html), scrape.NO_BASE_KIT)


class GmkDirectTests(unittest.TestCase):
    # Trimmed live markup from gmk.net's Warehouse Finds configurator: a
    # disabled (sold out) Base Set radio and an enabled one.
    WF_HTML = (
        '<form data-variant-switch="true" data-variant-switch-options="'
        '{&quot;url&quot;:&quot;https:\\/\\/www.gmk.net\\/shop\\/en\\/detail\\/019c\\/switch&quot;,'
        '&quot;pageType&quot;:&quot;product_detail&quot;}">'
        '<input type="radio" name="aa11" value="bb22" '
        'class="product-detail-configurator-option-input not-combinable disabled btn-check" '
        'id="x"> <label title="Arctic Base Set ">Arctic Base Set</label>'
        '<input type="radio" name="aa11" value="cc33" '
        'class="product-detail-configurator-option-input btn-check" '
        'id="y"> <label title="Lazurite Base Set ">Lazurite Base Set</label>'
        "</form>"
    )

    def test_parse_options_and_switch_url(self):
        switch_url, options = scrape.gmk_wf_parse_options(self.WF_HTML)
        self.assertEqual(switch_url, "https://www.gmk.net/shop/en/detail/019c/switch")
        self.assertEqual(len(options), 2)
        arctic, lazurite = options
        self.assertEqual(arctic["label"], "Arctic Base Set")
        self.assertFalse(arctic["available"])  # disabled = sold out
        self.assertEqual(lazurite["option_id"], "cc33")
        self.assertTrue(lazurite["available"])

    def test_base_set_label_mapping(self):
        self.assertEqual(scrape.gmk_wf_base_set_name("Lazurite Base Set"), "GMK Lazurite")
        self.assertEqual(
            scrape.gmk_wf_base_set_name("Nightrunner R2 Base Set"),
            "GMK Nightrunner R2",
        )
        # Legends qualifier dropped: the set is GMK Zen Pond.
        self.assertEqual(
            scrape.gmk_wf_base_set_name("Zen Pond Latin Base Set"), "GMK Zen Pond"
        )
        # Subkits are not base sets.
        self.assertIsNone(scrape.gmk_wf_base_set_name("Moonlight Spacebars Kit"))
        self.assertIsNone(scrape.gmk_wf_base_set_name("Blossom Accent Kit"))
        self.assertIsNone(scrape.gmk_wf_base_set_name("Hazakura Hiragana Set"))

    def test_price_from_buy_box_only(self):
        doc = (
            '<span class="header-cart-total">€0.00</span>'
            '<span class="product-detail-price-container">'
            '<meta itemprop="price" content="129">'
            '<p class="product-detail-price"> €129.00 </p></span>'
        )
        self.assertEqual(scrape.gmk_wf_price_from_html(doc), 129.0)
        # No buy box → no price (the €0.00 header must never match).
        self.assertIsNone(
            scrape.gmk_wf_price_from_html('<span class="header-cart-total">€0.00</span>')
        )
        # Implausible values are rejected.
        self.assertIsNone(
            scrape.gmk_wf_price_from_html(
                '<span class="product-detail-price-container">'
                '<meta itemprop="price" content="9999"></span>'
            )
        )

    def test_warehouse_label_matches_set_index(self):
        entry = {"status": "IN_STOCK", "gbStart": None}
        by_full = {"gmk lazurite": entry}
        by_base = {"gmk lazurite": [entry]}
        name = scrape.gmk_wf_base_set_name("Lazurite Base Set")
        self.assertIs(
            scrape.match_product_to_set(name, by_full, by_base), entry
        )

    def test_strip_round(self):
        self.assertEqual(scrape.strip_round("gmk striker r2"), "gmk striker")
        self.assertEqual(scrape.strip_round("gmk olive"), "gmk olive")

    def test_catalog_keeps_only_gmk_products(self):
        data = {
            "products": [
                {"title": "GMK Striker", "handle": "gmk-striker"},
                {"title": "PBT Heavy Industry", "handle": "pbt-heavy"},
                {"title": "GMK Olive", "handle": "gmk-olive"},
                {"title": "GMK No Handle"},  # dropped: no handle
            ]
        }
        out = scrape.gmk_products_from_catalog(data, "https://shop.test")
        self.assertEqual(
            out,
            [
                {"title": "GMK Striker", "url": "https://shop.test/products/gmk-striker"},
                {"title": "GMK Olive", "url": "https://shop.test/products/gmk-olive"},
            ],
        )

    def test_match_exact_round_aware(self):
        e_r1 = {"status": "DELIVERED", "gbStart": datetime(2020, 1, 1)}
        e_r2 = {"status": "ACTIVE_GB", "gbStart": datetime(2023, 1, 1)}
        by_full = {"gmk striker r1": e_r1, "gmk striker r2": e_r2}
        by_base = {"gmk striker": [e_r1, e_r2]}
        self.assertIs(
            scrape.match_product_to_set("GMK Striker R1", by_full, by_base), e_r1
        )

    def test_match_falls_back_to_active_round(self):
        e_r1 = {"status": "DELIVERED", "gbStart": datetime(2020, 1, 1)}
        e_r2 = {"status": "ACTIVE_GB", "gbStart": datetime(2023, 1, 1)}
        by_full = {"gmk striker r1": e_r1, "gmk striker r2": e_r2}
        by_base = {"gmk striker": [e_r1, e_r2]}
        # Bare "GMK Striker" (no round) → prefer the round that's actually selling
        self.assertIs(
            scrape.match_product_to_set("GMK Striker", by_full, by_base), e_r2
        )

    def test_match_returns_none_for_untracked(self):
        by_full = {"gmk striker": {"status": "ACTIVE_GB", "gbStart": None}}
        by_base = {"gmk striker": [by_full["gmk striker"]]}
        self.assertIsNone(
            scrape.match_product_to_set("GMK Nonexistent Set", by_full, by_base)
        )


class KeycapClassifierTests(unittest.TestCase):
    def test_leading_profile_is_keycap(self):
        self.assertTrue(scrape.kb_is_keycap({"title": "GMK Ramune TKL"}))
        self.assertTrue(scrape.kb_is_keycap({"title": "SA Vilebloom"}))

    def test_keycap_noun_anywhere_is_keycap(self):
        # These slipped into keyboard vendor collections before.
        self.assertTrue(
            scrape.kb_is_keycap(
                {"title": "[GB] Awekeys Viking Antiques Full Metal Keycaps - Base Kit"}
            )
        )
        self.assertTrue(scrape.kb_is_keycap({"title": "Mtbkeys Metal Spacebars"}))

    def test_real_keyboard_is_not_keycap(self):
        self.assertFalse(scrape.kb_is_keycap({"title": "Sonic170 v2 Keyboard Kit"}))
        self.assertFalse(scrape.kb_is_keycap({"title": "Finn 60XT"}))
        # Mentions PBT keycaps but is an actual board → keyboard word guards it.
        self.assertFalse(
            scrape.kb_is_keycap(
                {"title": "KBDfans Electrostatic keyboard 9009 PBT dye-sub"}
            )
        )


if __name__ == "__main__":
    unittest.main()
