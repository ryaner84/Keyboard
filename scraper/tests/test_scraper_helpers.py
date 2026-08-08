from __future__ import annotations

import sys
import unittest
from datetime import datetime
from pathlib import Path


SCRAPER_DIR = Path(__file__).resolve().parents[1]
if str(SCRAPER_DIR) not in sys.path:
    sys.path.insert(0, str(SCRAPER_DIR))

import scrape
from scrapling_client import (
    ScraplingClient,
    ScraplingStats,
    decode_response_body,
    response_is_blocked,
)


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

    def test_bundle_never_displaces_a_real_base_kit(self):
        # A bundle's price is not the standalone base price, so whenever the
        # listing offers a plain base the base wins — in EITHER variant order,
        # so the stored price can't depend on the vendor's display sort.
        bundle = {"id": "1", "title": "Base Kit + Novelties Bundle", "price": 155}
        base = {"id": "2", "title": "Base Kit", "price": 135}
        self.assertEqual(scrape.choose_kit_variant([bundle, base])["price"], 135)
        self.assertEqual(scrape.choose_kit_variant([base, bundle])["price"], 135)

    def test_bundle_only_listing_is_priced_rather_than_skipped(self):
        # Narrowed from "a bundle-only listing clears": ktechs sells four GMK
        # sets with a single "Base + Novelties" variant, so clearing meant
        # those listings were invisible. With no base on offer the bundle is
        # the best available number.
        variants = [{"id": "1", "title": "Base Kit + Novelties Bundle", "price": 155}]
        self.assertEqual(scrape.choose_kit_variant(variants)["price"], 155)

    def test_ktechs_hanami_dango_shape_is_priced(self):
        # The live listing, verbatim: ktechs/products/gmk-hanami-dango has one
        # variant titled "Base + Novelties" — no "Kit", no "Bundle" — at $88.
        # The title carries neither of the words the earlier tests happen to
        # include, so it is asserted separately rather than assumed covered.
        variants = [{"id": "1", "title": "Base + Novelties", "price": 88.0}]
        self.assertEqual(scrape.classify_variant("Base + Novelties"), "BUNDLE")
        chosen = scrape.choose_kit_variant(variants)
        self.assertIsNotNone(chosen)
        self.assertEqual(chosen["price"], 88.0)
        self.assertTrue(scrape.is_plausible_base_price(chosen["price"], "USD"))

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

    def test_jsonld_bundle_is_used_when_no_plain_base_is_offered(self):
        # Was: excluded outright. Narrowed — with only a bundle and a subkit on
        # offer, the bundle is the base-bearing option and the best number
        # available. A plain base, when present, still wins (covered above).
        html = self._jsonld(
            '{"name":"Base Kit + Novelties Bundle","price":"155"},'
            '{"name":"Spacebars","price":"29"}'
        )
        offer = scrape.parse_jsonld_offer(html)
        self.assertIsNot(offer, scrape.NO_BASE_KIT)
        self.assertEqual(offer["price"], 155.0)


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

    def test_bare_title_prefers_active_round_over_original_run(self):
        # Original runs are stored WITHOUT a round suffix, and vendors sell the
        # CURRENT round under the bare name. The old exact-first match attached
        # a bare-titled R2 listing (and its price) to the round-1 row.
        r1 = {"status": "DELIVERED", "gbStart": datetime(2020, 1, 1)}
        r2 = {"status": "ACTIVE_GB", "gbStart": datetime(2026, 6, 1)}
        by_full = {"gmk striker": r1, "gmk striker r2": r2}
        by_base = {"gmk striker": [r1, r2]}
        self.assertIs(
            scrape.match_product_to_set("GMK Striker", by_full, by_base), r2
        )
        # An explicit round stays an exact match.
        self.assertIs(
            scrape.match_product_to_set("GMK Striker R2", by_full, by_base), r2
        )

    def test_bare_title_all_rounds_delivered_prefers_newest(self):
        r1 = {"status": "DELIVERED", "gbStart": datetime(2019, 3, 1)}
        r2 = {"status": "DELIVERED", "gbStart": datetime(2023, 9, 1)}
        by_full = {"gmk olive": r1, "gmk olive r2": r2}
        by_base = {"gmk olive": [r1, r2]}
        self.assertIs(
            scrape.match_product_to_set("GMK Olive", by_full, by_base), r2
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


class KbdfansGroupBuyTests(unittest.TestCase):
    def _prod(self, title, ptype, tags, handle="h", image="https://img/x.jpg"):
        return {
            "title": title,
            "product_type": ptype,
            "tags": tags,
            "handle": handle,
            "images": [{"src": image}] if image else [],
        }

    def test_interest_check_gmk_keycap_is_captured(self):
        d = scrape.kbdfans_gb_product_to_set(
            self._prod("GMK CYL Desert Nights",
                       "Interest Check",
                       ["CYL", "GMK Keycaps", "Group Buy", "Interest Check", "Keycaps"],
                       handle="gmk-cyl-desert-nights")
        )
        self.assertIsNotNone(d)
        self.assertEqual(d["status"], "INTEREST_CHECK")
        # CYL profile token stripped so it dedupes against the canonical slug.
        self.assertEqual(d["slug"], "gmk-desert-nights")
        self.assertEqual(d["colorway"], "Desert Nights")
        self.assertEqual(d["productUrl"], "https://kbdfans.com/products/gmk-cyl-desert-nights")

    def test_group_buy_live_maps_to_active(self):
        d = scrape.kbdfans_gb_product_to_set(
            self._prod("GMK CYL Noire",
                       "Group Buy Is Live",
                       ["CYL", "GMK Keycaps", "Group Buy", "Live", "Keycaps"])
        )
        self.assertIsNotNone(d)
        self.assertEqual(d["status"], "ACTIVE_GB")
        self.assertEqual(d["slug"], "gmk-noire")

    def test_in_production_is_skipped(self):
        self.assertIsNone(
            scrape.kbdfans_gb_product_to_set(
                self._prod("GMK CYL Spark", "In Production",
                           ["CYL", "GMK Keycaps", "Group Buy", "In Production", "Keycaps"])
            )
        )

    def test_non_gmk_product_is_skipped(self):
        self.assertIsNone(
            scrape.kbdfans_gb_product_to_set(
                self._prod("Tofu60 2.0 Keyboard Kit", "Group Buy Is Live",
                           ["Keyboards", "Group Buy", "Live"])
            )
        )

    def test_mtnu_token_stripped_to_canonical_slug(self):
        d = scrape.kbdfans_gb_product_to_set(
            self._prod("GMK MTNU Divinapapaya", "Interest Check",
                       ["MTNU", "GMK Keycaps", "Interest Check", "Keycaps"])
        )
        self.assertEqual(d["slug"], "gmk-divinapapaya")

    def test_merge_status_never_reactivates_terminal(self):
        self.assertEqual(scrape._kbdfans_merge_status("DELIVERED", "ACTIVE_GB"), "DELIVERED")
        self.assertEqual(scrape._kbdfans_merge_status("CANCELLED", "INTEREST_CHECK"), "CANCELLED")

    def test_merge_status_never_downgrades_live_to_ic(self):
        self.assertEqual(scrape._kbdfans_merge_status("ACTIVE_GB", "INTEREST_CHECK"), "ACTIVE_GB")

    def test_merge_status_promotes_and_creates(self):
        # incoming ACTIVE promotes any non-terminal row
        self.assertEqual(scrape._kbdfans_merge_status("SHIPPING", "ACTIVE_GB"), "ACTIVE_GB")
        self.assertEqual(scrape._kbdfans_merge_status("INTEREST_CHECK", "ACTIVE_GB"), "ACTIVE_GB")
        # incoming IC only fills a blank or already-IC row
        self.assertEqual(scrape._kbdfans_merge_status(None, "INTEREST_CHECK"), "INTEREST_CHECK")
        self.assertEqual(scrape._kbdfans_merge_status("INTEREST_CHECK", "INTEREST_CHECK"), "INTEREST_CHECK")
        # incoming IC must NOT drag a shipping row back to interest check
        self.assertEqual(scrape._kbdfans_merge_status("SHIPPING", "INTEREST_CHECK"), "SHIPPING")


class GmkBreadcrumbStatusTests(unittest.TestCase):
    # A page like gmk.net's: a <script> mentioning "navigation" and shipping
    # routes, plus the REAL breadcrumb that reads "Home > Group Buys".
    PAGE = (
        "<html><head><script>"
        "window.router['frontend.shopware_analytics.customer.data'] = "
        "'/shop/en/storefront/script/shopware-analytics-customer';"
        "window.navigation = {shipping:'/ship', fulfilment:'/fulfil'};"
        "</script></head><body>"
        '<nav class="breadcrumb" aria-label="breadcrumb"><ol class="breadcrumb-list">'
        '<li class="breadcrumb-item"><a href="/">Home</a></li>'
        '<li class="breadcrumb-item"><a href="/shop/en/group-buys/">Group Buys</a></li>'
        "</ol></nav></body></html>"
    )

    def test_breadcrumb_ignores_script_navigation_blob(self):
        # Must return the real breadcrumb, not the <script> JS containing "shipping".
        self.assertEqual(scrape.gmk_breadcrumb_text(self.PAGE), "Home Group Buys")

    def test_group_buy_breadcrumb_infers_active(self):
        url = "https://www.gmk.net/shop/en/gmk-cyl-gonzales-keycaps/gmk10100"
        status = scrape.infer_status_from_text(url + " " + scrape.gmk_breadcrumb_text(self.PAGE))
        self.assertEqual(status, "ACTIVE_GB")

    def test_in_production_breadcrumb_infers_shipping(self):
        page = (
            '<nav class="breadcrumb"><ol class="breadcrumb-list">'
            '<li class="breadcrumb-item">Home</li>'
            '<li class="breadcrumb-item">In Production</li></ol></nav>'
        )
        self.assertEqual(scrape.gmk_breadcrumb_text(page), "Home In Production")
        self.assertEqual(
            scrape.infer_status_from_text("https://x/y " + scrape.gmk_breadcrumb_text(page)),
            "SHIPPING",
        )

    def test_no_breadcrumb_does_not_leak_script_shipping(self):
        # Only a script blob (no breadcrumb element) -> empty, so a set never
        # falsely infers SHIPPING from unrelated page JS.
        page = "<script>var x = 'shipping fulfilment navigation';</script>"
        self.assertEqual(scrape.gmk_breadcrumb_text(page), "")
        self.assertEqual(scrape.infer_status_from_text("https://x/y "), "DELIVERED")


class TrackedProfileCatalogTests(unittest.TestCase):
    def _data(self, *titles):
        return {"products": [{"title": t, "handle": t.lower().replace(" ", "-")} for t in titles]}

    def test_keeps_gmk_and_dcs_listings(self):
        out = scrape.tracked_products_from_catalog(
            self._data("GMK Olivia R2", "DCS Superweld", "DCS Cream Cheese and Green R3"),
            "https://novelkeys.com",
        )
        self.assertEqual(
            [p["title"] for p in out],
            ["GMK Olivia R2", "DCS Superweld", "DCS Cream Cheese and Green R3"],
        )
        self.assertEqual(out[1]["url"], "https://novelkeys.com/products/dcs-superweld")

    def test_drops_untracked_profiles_and_handleless(self):
        out = scrape.tracked_products_from_catalog(
            {
                "products": [
                    {"title": "KAT Milkshake", "handle": "kat-milkshake"},
                    {"title": "SA Laser", "handle": "sa-laser"},
                    {"title": "GMK No Handle"},  # unusable without a handle
                ]
            },
            "https://x.test",
        )
        self.assertEqual(out, [])

    def test_legacy_alias_still_exposed(self):
        # run_discovery calls the old name; it must keep working.
        self.assertIs(scrape.gmk_products_from_catalog, scrape.tracked_products_from_catalog)

    def test_dcs_and_gmk_normalize_to_different_sets(self):
        # The profile token is the identity: a DCS set must never be matched to
        # the same-colourway GMK set by the vendor-linking normalizer.
        self.assertNotEqual(
            scrape.normalize_set_name("DCS Dolch"),
            scrape.normalize_set_name("GMK Dolch"),
        )


# Trimmed from the live pages (2026-07). The class soup is kept verbatim on the
# elements the parsers key off, so a dcs.wiki redesign fails here rather than
# silently writing blanks over good rows.
_DCS_LABEL_CLASS = 'class="text-[10px] uppercase tracking-wide font-semibold text-gray-400 mb-0.5"'
_DCS_VALUE_CLASS = 'class="text-sm font-medium text-gray-800"'


def _dcs_pair(label: str, value: str) -> str:
    return (f"<p {_DCS_LABEL_CLASS}>{label}</p>"
            f"<p {_DCS_VALUE_CLASS}>{value}</p>")


DCS_GROUP_BUYS_HTML = (
    '<section><h1 class="text-3xl font-bold">Active Group Buys</h1>'
    '<a class="block" aria-label="Open DCS Rainbow details" href="/keycaps/dcs-rainbow">'
    '<h3>DCS Rainbow</h3></a>'
    '<a class="block" aria-label="Open DCS Soju details" href="/keycaps/dcs-soju">'
    '<h3>DCS Soju</h3></a>'
    '</section>'
    '<section><h1 class="text-3xl font-bold">Active Interest Checks</h1>'
    '<a href="https://ankitsachdeva.com/dcs-lily/" rel="noopener noreferrer">'
    '<p class="text-base font-semibold">DCS Lily Revival</p>'
    '<p class="mt-1.5 text-sm">The 2013 geekhack group buy, back for a new run</p></a>'
    '<a href="https://geekhack.org/index.php?topic=126911.0">'
    '<p class="text-base font-semibold">DCS VoC (Violet on Cream)</p>'
    '<p class="mt-1.5 text-sm">A classic VoC colorway</p></a>'
    '<a href="https://geekhack.org/index.php?topic=126299.0">'
    '<p class="text-base font-semibold">DCS Mermaid</p>'
    '<p class="mt-1.5 text-sm">Teal and pink colorway</p></a>'
    '<a href="/about">About</a>'
    '</section>'
)

DCS_ARCHIVE_HTML = (
    '<h2>2026</h2>'
    '<a class="block" aria-label="Open DCS Soju details" href="/keycaps/dcs-soju"><div/></a>'
    '<h2>2023</h2>'
    '<a class="block" aria-label="Open DCS Alchemy details" href="/keycaps/dcs-alchemy"><div/></a>'
    '<a class="block" aria-label="Open DCS 9009 details" href="/keycaps/dcs-9009"><div/></a>'
    # The same set is linked again by a "related sets" rail — must not duplicate.
    '<a class="block" aria-label="Open DCS Soju details" href="/keycaps/dcs-soju"><div/></a>'
    '<nav><a href="/keycaps">Keycaps</a><a href="/about">About</a></nav>'
)

DCS_SOJU_HTML = (
    '<html><head><title>DCS Soju | DCS Keycaps</title>'
    '<meta name="description" content="DCS SOJU BLUE, the sequel by KEI &quot;Jinro Is Back&quot;."/>'
    '<link rel="preload" as="image" href="/images/dcs_soju_6.png"/>'
    '<link rel="preload" as="image" href="/images/dcs_soju.jpg"/>'
    '<script>window.__NEXT_DATA__ = {"name":"NOT THE NAME"}</script>'
    '</head><body><h1 class="text-4xl font-bold">DCS Soju</h1>'
    + _dcs_pair("Designer", "Sauceinmyveins")
    + _dcs_pair("Release Date", "7/1/2026")
    + _dcs_pair("GB Type", "Public")
    + _dcs_pair("Colors", "BHG, BE, WGE")
    + _dcs_pair("Price", "—")
    + _dcs_pair("Group Buy Location", "Unikeys")
    + f'<div><p {_DCS_LABEL_CLASS}>Group Buy Page</p>'
      '<a href="https://unikeyboards.com/products/gb-dcs-soju-blue-keycap-set" '
      'target="_blank" rel="noopener noreferrer">View Group Buy</a></div>'
    '</body></html>'
)

DCS_RAINBOW_HTML = (
    '<html><head><title>DCS Rainbow | DCS Keycaps</title>'
    '<meta name="description" content="DCS version of GMK set; Ran by DN."/>'
    '<link rel="preload" as="image" href="/images/rainbow.png"/>'
    '</head><body><h1>DCS Rainbow</h1>'
    + _dcs_pair("Designer", "DNWorks")
    + _dcs_pair("Release Date", "7/1/2026")
    + _dcs_pair("Colors", "—")
    + _dcs_pair("Price", "—")
    + _dcs_pair("Group Buy Location", "DN Discord")
    + '</body></html>'
)


class DcsWikiParsingTests(unittest.TestCase):
    def test_group_buys_page_splits_live_gbs_from_interest_checks(self):
        live = scrape.parse_dcs_group_buys(DCS_GROUP_BUYS_HTML)
        # Active GBs are identified by SLUG, not by name — their cards link to
        # the wiki page, so there is nothing to guess.
        self.assertEqual(live["active_slugs"], ["dcs-rainbow", "dcs-soju"])
        names = [ic["name"] for ic in live["interest_checks"]]
        self.assertEqual(
            names,
            ["DCS Lily Revival", "DCS VoC (Violet on Cream)", "DCS Mermaid"],
        )
        # The trailing "/about" nav link is not a set.
        self.assertNotIn("About", names)

    def test_interest_checks_carry_geekhack_topic_ids_when_present(self):
        by_name = {
            ic["name"]: ic
            for ic in scrape.parse_dcs_group_buys(DCS_GROUP_BUYS_HTML)["interest_checks"]
        }
        self.assertEqual(by_name["DCS Mermaid"]["topic_id"], "126299")
        self.assertEqual(by_name["DCS VoC (Violet on Cream)"]["topic_id"], "126911")
        # No Geekhack thread -> no topic id, so apply_dcs_interest_checks skips
        # it rather than guessing which row it means. This matters here: the
        # archive has a delivered "DCS Lily" that must NOT be reopened by the
        # separate "DCS Lily Revival" interest check.
        self.assertIsNone(by_name["DCS Lily Revival"]["topic_id"])

    def test_archive_index_yields_unique_slugs_with_names(self):
        entries = scrape.parse_dcs_archive_index(DCS_ARCHIVE_HTML)
        self.assertEqual(
            entries,
            [
                {"slug": "dcs-soju", "name": "DCS Soju"},
                {"slug": "dcs-alchemy", "name": "DCS Alchemy"},
                {"slug": "dcs-9009", "name": "DCS 9009"},
            ],
        )

    def test_set_page_reads_identity_fields_and_vendor_group_buy_link(self):
        data = scrape.parse_dcs_set_page(
            DCS_SOJU_HTML, "https://dcs.wiki/keycaps/dcs-soju"
        )
        self.assertEqual(data["slug"], "dcs-soju")
        self.assertEqual(data["name"], "DCS Soju")
        self.assertEqual(data["colorway"], "Soju")
        self.assertEqual(data["designer"], "Sauceinmyveins")
        self.assertEqual(data["release_date"], datetime(2026, 7, 1))
        self.assertEqual(data["colors"], "BHG, BE, WGE")
        # The whole point of the pass: a scrapeable vendor listing URL.
        self.assertEqual(
            data["gb_page_url"],
            "https://unikeyboards.com/products/gb-dcs-soju-blue-keycap-set",
        )
        self.assertEqual(data["imageUrl"], "https://dcs.wiki/images/dcs_soju_6.png")
        self.assertIn("https://dcs.wiki/images/dcs_soju.jpg", data["images"])
        self.assertTrue(data["description"].startswith("DCS SOJU BLUE"))
        self.assertIn('"Jinro Is Back"', data["description"])

    def test_set_page_returns_none_for_blank_optional_fields(self):
        data = scrape.parse_dcs_set_page(
            DCS_RAINBOW_HTML, "https://dcs.wiki/keycaps/dcs-rainbow"
        )
        # Em-dash placeholders must become None, never the literal "—", so the
        # upsert's COALESCE/blank guards leave existing data alone.
        self.assertIsNone(data["colors"])
        self.assertIsNone(data["price"])
        self.assertIsNone(data["gb_page_url"])
        self.assertEqual(data["gb_location"], "DN Discord")

    def test_set_page_without_a_name_is_skipped(self):
        # A blocked or truncated fetch must skip the set rather than upsert a
        # row with an empty name over a good one.
        self.assertIsNone(scrape.parse_dcs_set_page("", "https://dcs.wiki/keycaps/x"))
        self.assertIsNone(
            scrape.parse_dcs_set_page("<html><body>nope</body></html>",
                                      "https://dcs.wiki/keycaps/dcs-x")
        )

    def test_release_dates_parse_or_return_none(self):
        self.assertEqual(scrape.parse_dcs_release_date("7/1/2026"), datetime(2026, 7, 1))
        self.assertEqual(scrape.parse_dcs_release_date("January 2023"), datetime(2023, 1, 1))
        self.assertEqual(scrape.parse_dcs_release_date("July 2026"), datetime(2026, 7, 1))
        self.assertEqual(scrape.parse_dcs_release_date("2021"), datetime(2021, 1, 1))
        for junk in (None, "", "soon", "TBD", "13/40/2026"):
            self.assertIsNone(scrape.parse_dcs_release_date(junk), junk)

    def test_every_manufacturer_source_is_registered_as_unpriceable(self):
        # Regression: dcs.wiki shipped without being added to the manufacturer
        # list, so all 135 wiki rows entered the price queue — and having never
        # been priced they sorted FIRST under `priceUpdatedAt ASC NULLS FIRST`,
        # crowding real vendor listings out of the 500-row cap. Any catalog
        # source that gets a VendorKit row must be registered here.
        self.assertIn(scrape.GMK_VENDOR_SLUG, scrape.MANUFACTURER_VENDOR_SLUGS)
        self.assertIn(scrape.DCS_VENDOR_SLUG, scrape.MANUFACTURER_VENDOR_SLUGS)
        # The URL guard is the belt-and-braces half: a manufacturer link that
        # somehow lands on a store's VendorKit row still must not be priced.
        self.assertTrue(
            any("dcs.wiki" in p for p in scrape.MANUFACTURER_URL_PATTERNS)
        )
        self.assertTrue(
            any("gmk.net" in p for p in scrape.MANUFACTURER_URL_PATTERNS)
        )

    def test_dcs_and_gmk_sets_keep_separate_identities(self):
        # dcs.wiki now creates official "DCS …" rows, so the guard that keeps
        # them from collapsing into the same-colourway GMK set still holds.
        self.assertNotEqual(
            scrape.normalize_set_name("DCS Soju"),
            scrape.normalize_set_name("GMK Soju"),
        )


class ZFrontierStorefrontTests(unittest.TestCase):
    """zFrontier runs two sites and the vendor row pointed at the wrong one.

    www.zfrontier.com is the CN app the GB-card pass reads; en.zfrontier.com is
    an ordinary Shopify storefront (359 products, 107 GMK/DCS). Discovery builds
    {websiteUrl host}/products.json, so pointing the vendor at the app produced
    a 404 on every run — silently, since an unreadable catalogue just skips.
    """

    def test_vendor_points_at_the_shopify_storefront(self):
        self.assertEqual(scrape.ZFRONTIER_STORE_ORIGIN, "https://en.zfrontier.com")
        self.assertIn("en.zfrontier.com", scrape.ZFRONTIER_STORE_ORIGIN)

    def test_gb_card_pass_still_uses_the_app_host(self):
        # The two hosts do different jobs; collapsing them would break the
        # group-buy card scrape, which has no Shopify equivalent.
        self.assertEqual(scrape.ZFRONTIER_ORIGIN, "https://www.zfrontier.com")
        self.assertNotEqual(scrape.ZFRONTIER_ORIGIN, scrape.ZFRONTIER_STORE_ORIGIN)
        self.assertTrue(scrape.ZFRONTIER_GB_URL.startswith(scrape.ZFRONTIER_ORIGIN))

    def test_storefront_host_resolves_for_discovery(self):
        # Discovery and find_vendor_for_url both key off the URL host.
        self.assertEqual(scrape._dcs_host(scrape.ZFRONTIER_STORE_ORIGIN), "en.zfrontier.com")


class BundleVariantTests(unittest.TestCase):
    """"Base + Novelties" is its own category, not BASE and not NOVELTIES.

    Filed as NOVELTIES it was dropped from the base pool, so a listing whose
    only variant is a bundle stored no price at all — ktechs sells four GMK
    sets exactly that way (Hanami Dango $88, Tako, Orange Boi, Kitsune), and
    iLumKB one more. Filed as BASE it could outrank a real base kit in the same
    listing, making the stored price depend on the vendor's variant order.
    """

    def test_bundles_classify_as_bundle(self):
        for title in (
            "Base + Novelties",
            "Base+Free Alphas+Spacebar",   # iLumKB Matsu — no spaces
            "Base Kit + Novelties",
            "Base and Novelties",
            "Base & Spacebars",
        ):
            self.assertEqual(scrape.classify_variant(title), "BUNDLE", title)

    def test_colourway_names_with_joiners_are_not_bundles(self):
        # Observed in production: Oblotzky's "Teal & White Base" and Yushakobo's
        # "Two Baseセット（Teal + White）" are plain base kits whose COLOURWAY
        # contains a joiner. Requiring a joiner alone filed them as bundles,
        # which would have mislabelled them and changed which variant was picked.
        for title in (
            "Teal & White Base",
            "Two Base\u30bb\u30c3\u30c8\uff08Teal + White\uff09",
            "Black & Gold Base Kit",
        ):
            self.assertEqual(scrape.classify_variant(title), "BASE", title)

    def test_bundle_must_name_an_actual_extra_kit(self):
        # These come from live listings (KBDfans GMK Selene / Thunder God).
        for title in (
            "Base+Novelties+Extension+Space",
            "Base+Novelties+Extension",
            "Base+Novelties",
        ):
            self.assertEqual(scrape.classify_variant(title), "BUNDLE", title)

    def test_plain_base_and_plain_subkits_are_unchanged(self):
        self.assertEqual(scrape.classify_variant("Base Kit"), "BASE")
        self.assertEqual(scrape.classify_variant("Novelties"), "NOVELTIES")
        self.assertEqual(scrape.classify_variant("Spacebars"), "SPACEBARS")
        # A subkit that merely mentions the base is still a subkit.
        self.assertEqual(scrape.classify_variant("Novelties (fits base)"), "NOVELTIES")

    def test_bundle_only_listings_are_now_priced(self):
        for title, price in [("Base + Novelties", 88.0),
                             ("Base+Free Alphas+Spacebar", 239.0)]:
            chosen = scrape.choose_kit_variant([{"id": "1", "title": title, "price": price}])
            self.assertIsNotNone(chosen, title)
            self.assertEqual(chosen["price"], price)

    def test_cheapest_bundle_wins_when_several(self):
        chosen = scrape.choose_kit_variant([
            {"id": "1", "title": "Base + Novelties + Spacebars", "price": 210.0},
            {"id": "2", "title": "Base + Novelties", "price": 180.0},
        ])
        self.assertEqual(chosen["price"], 180.0)

    def test_a_real_base_always_beats_a_bundle_in_either_order(self):
        bundle = {"id": "1", "title": "Base + Novelties", "price": 155.0}
        base = {"id": "2", "title": "Base Kit", "price": 135.0}
        self.assertEqual(scrape.choose_kit_variant([bundle, base])["price"], 135.0)
        self.assertEqual(scrape.choose_kit_variant([base, bundle])["price"], 135.0)

    def test_subkit_only_listings_still_store_nothing(self):
        self.assertIsNone(scrape.choose_kit_variant([
            {"id": "1", "title": "GMK Rainy Day Novelties", "price": 38.0},
            {"id": "2", "title": "GMK Rainy Day Spacebars", "price": 30.0},
        ]))


class ApostropheNormalisationTests(unittest.TestCase):
    """An apostrophe INSIDE a token used to split it and kill the match.

    "40's" became "40 s" and stopped matching a set's "40s" — a real miss on
    Prototypist / Keebz n Cables' DCS After School 1992. A TRAILING possessive
    ("Davy Jones' Locker") always worked, which is why this stayed hidden.
    """

    def test_apostrophe_inside_a_token_no_longer_splits_it(self):
        self.assertEqual(
            scrape.normalize_set_name("DCS After School 1992 - 40's Keycap Kit"),
            scrape.normalize_set_name("DCS After School 1992 40s kit"),
        )
        self.assertEqual(
            scrape.normalize_set_name("KAM Li'l Dragon Keyset"),
            scrape.normalize_set_name("KAM Lil Dragon"),
        )

    def test_trailing_possessive_still_matches(self):
        self.assertEqual(
            scrape.normalize_set_name("GMK Davy Jones' Locker Keycaps"),
            scrape.normalize_set_name("GMK Davy Jones Locker"),
        )

    def test_curly_apostrophe_is_handled_too(self):
        self.assertEqual(
            scrape.normalize_set_name("KAM Li\u2019l Dragon"),
            scrape.normalize_set_name("KAM Lil Dragon"),
        )

    def test_distinct_sets_still_do_not_collide(self):
        self.assertNotEqual(
            scrape.normalize_set_name("DCS Dolch"),
            scrape.normalize_set_name("GMK Dolch"),
        )


class DiscoveryPagingTests(unittest.TestCase):
    def test_page_cap_covers_the_largest_known_catalogue(self):
        # Prototypist carries 1500+ products; at 250/page a cap of 4 hid 106
        # GMK/DCS items on pages 5-6 with no log line to show for it.
        self.assertGreaterEqual(scrape._DISCOVERY_MAX_CATALOG_PAGES, 6)


class CompareAtPriceTests(unittest.TestCase):
    def test_markdown_is_captured_when_compare_exceeds_price(self):
        out = scrape._parse_shopify_variants([
            {"id": 1, "title": "Base Kit", "price": "99.00", "compare_at_price": "135.00"},
        ])
        self.assertEqual(out[0]["price"], 99.0)
        self.assertEqual(out[0]["compareAt"], 135.0)

    def test_equal_compare_is_not_a_discount(self):
        # Shopify leaves compare_at_price populated at the SAME value on plenty
        # of listings. Treating that as a markdown would advertise 0% off across
        # half the catalogue.
        out = scrape._parse_shopify_variants([
            {"id": 1, "title": "Base Kit", "price": "135.00", "compare_at_price": "135.00"},
        ])
        self.assertNotIn("compareAt", out[0])

    def test_lower_compare_is_ignored(self):
        # compare_at BELOW price is bad vendor data, not a negative discount.
        out = scrape._parse_shopify_variants([
            {"id": 1, "title": "Base Kit", "price": "135.00", "compare_at_price": "99.00"},
        ])
        self.assertNotIn("compareAt", out[0])

    def test_missing_or_null_compare_is_fine(self):
        out = scrape._parse_shopify_variants([
            {"id": 1, "title": "A", "price": "135.00", "compare_at_price": None},
            {"id": 2, "title": "B", "price": "40.00"},
        ])
        self.assertEqual(len(out), 2)
        for v in out:
            self.assertNotIn("compareAt", v)

    def test_price_parsing_is_unaffected_by_junk_compare(self):
        out = scrape._parse_shopify_variants([
            {"id": 1, "title": "A", "price": "135.00", "compare_at_price": "not-a-number"},
        ])
        self.assertEqual(out[0]["price"], 135.0)
        self.assertNotIn("compareAt", out[0])


class MultiSetListingExclusionTests(unittest.TestCase):
    """A clearance page holding MANY sets must never link as one set's listing.

    Surveyed across every vendor's clearance collections: the shape is rare but
    real, and confined to NovelKeys plus GMK's own Warehouse Finds. The common
    case — one set with many kits (KAT Space Dust, CRP R4) — is handled by
    choose_kit_variant and must keep working.
    """

    def _excluded(self, title: str) -> bool:
        return bool(scrape._TITLE_ACCESSORY_RE.search(title))

    def test_multi_set_clearance_listings_are_excluded(self):
        for title in (
            "GMK Leftovers",
            "In stock GMK Leftovers",
            "GMK Child Kits",
            "GMK Child Kit",
            "Zoom75 Extra Badge",
        ):
            self.assertTrue(self._excluded(title), title)

    def test_artisans_stay_excluded(self):
        # Their variants are named after real sets (RAMA Artisans -> bushido,
        # bento, awaken), so a miss here links an artisan to a GMK set.
        for title in ("RAMA Artisans", "Salvun Artisans", "HIBI Artisans"):
            self.assertTrue(self._excluded(title), title)

    def test_real_sets_are_not_caught(self):
        # The exclusion must not swallow ordinary listings — including a set
        # whose own name contains a word near the new patterns.
        for title in (
            "GMK Bingsu R2",
            "GMK Botanical Keycaps",
            "DCS Soju",
            "GMK Foo Extras",
            "KAT Space Dust Keycaps",
            "CRP R4",
        ):
            self.assertFalse(self._excluded(title), title)


class OutletCollectionTests(unittest.TestCase):
    def test_entries_are_plain_product_json_urls(self):
        # The list used to be (vendor_slug, url) pairs; a wrong slug skipped
        # silently. Entries are now URLs whose host resolves to the vendor.
        self.assertGreater(len(scrape.OUTLET_COLLECTIONS), 1)
        for url in scrape.OUTLET_COLLECTIONS:
            self.assertIsInstance(url, str, url)
            self.assertTrue(url.startswith("https://"), url)
            self.assertTrue(url.endswith("/products.json"), url)

    def test_no_duplicate_collections(self):
        self.assertEqual(
            len(scrape.OUTLET_COLLECTIONS), len(set(scrape.OUTLET_COLLECTIONS))
        )


class BaseKitPriceBoundsTests(unittest.TestCase):
    def test_cheap_accessory_prices_are_accepted(self):
        # The dcs.wiki archive tracks accessory products as first-class sets
        # (DCS Bae Addon, 6u bars, 10U Spacebars, 9009 Fix Kit). Their real
        # price is a few dollars, and the old USD 30 floor discarded them —
        # sneakbox's DCS Bae listing was skipped as "implausible" at 3.9 USD.
        self.assertTrue(scrape.is_plausible_base_price(3.9, "USD"))
        self.assertTrue(scrape.is_plausible_base_price(12.0, "USD"))
        self.assertTrue(scrape.is_plausible_base_price(29.99, "USD"))

    def test_normal_set_prices_still_accepted(self):
        self.assertTrue(scrape.is_plausible_base_price(135.0, "USD"))
        self.assertTrue(scrape.is_plausible_base_price(60.0, "EUR"))

    def test_ceiling_still_rejects_bundles_and_parse_errors(self):
        # The upper bound is NOT removed: a price far above a base kit is a
        # bundle or a parse failure, not a real listing.
        self.assertFalse(scrape.is_plausible_base_price(2999.0, "USD"))
        self.assertFalse(scrape.is_plausible_base_price(40000.0, "JPY"))

    def test_zero_and_negative_are_still_refused(self):
        # Not a "cheap product" — always a parse failure, and it would render
        # as a $0.00 best price on the set page.
        self.assertFalse(scrape.is_plausible_base_price(0, "USD"))
        self.assertFalse(scrape.is_plausible_base_price(-5, "USD"))
        # Unbounded currency: still refuse a non-positive price.
        self.assertFalse(scrape.is_plausible_base_price(0, "NOK"))
        self.assertTrue(scrape.is_plausible_base_price(50, "NOK"))

    def test_no_currency_bound_has_a_floor_left(self):
        # A stale floor in any currency would silently drop that store's
        # accessory prices while others worked.
        for currency, (low, _high) in scrape._KIT_BOUNDS.items():
            self.assertEqual(low, 0, f"{currency} still has a price floor")


class HostThrottleTests(unittest.TestCase):
    def test_same_host_is_spaced_out_but_different_hosts_are_not(self):
        # interval big enough to measure, jitter off so the assert is exact.
        throttle = scrape.HostThrottle(interval=0.25, jitter=0.0)
        self.assertEqual(throttle.wait("https://a.test/products/x.json"), 0.0)
        # A different host must never wait on the first one — a queue spread
        # across many stores should cost close to nothing.
        self.assertEqual(throttle.wait("https://b.test/products/y.json"), 0.0)
        # Back to the first host: this one has to wait.
        slept = throttle.wait("https://a.test/products/z.json")
        self.assertGreater(slept, 0.0)
        self.assertLessEqual(slept, 0.25)

    def test_interleave_spreads_clustered_hosts_without_losing_rows(self):
        # The price queue is oldest-first, which clusters by host: everything
        # discovered in one run shares a timestamp. That clustering is the only
        # case the throttle actually has to sleep through.
        clustered = [
            {"productUrl": "https://a.test/products/1"},
            {"productUrl": "https://a.test/products/2"},
            {"productUrl": "https://a.test/products/3"},
            {"productUrl": "https://b.test/products/1"},
            {"productUrl": "https://b.test/products/2"},
            {"productUrl": "https://c.test/products/1"},
        ]
        spread = scrape.HostThrottle.interleave(clustered)
        self.assertEqual(len(spread), len(clustered))
        self.assertCountEqual(spread, clustered)  # no row invented or dropped
        hosts = [u["productUrl"].split("/")[2] for u in spread]
        self.assertEqual(hosts[:3], ["a.test", "b.test", "c.test"])
        # Oldest-first is preserved WITHIN each host.
        a_urls = [u["productUrl"] for u in spread if "a.test" in u["productUrl"]]
        self.assertEqual(a_urls, [
            "https://a.test/products/1",
            "https://a.test/products/2",
            "https://a.test/products/3",
        ])

    def test_interleave_tolerates_missing_urls(self):
        rows = [{"productUrl": None}, {}, {"productUrl": "https://a.test/x"}]
        self.assertEqual(len(scrape.HostThrottle.interleave(rows)), 3)

    def test_blank_and_malformed_urls_never_block_the_pass(self):
        throttle = scrape.HostThrottle(interval=5.0, jitter=0.0)
        for url in ("", None, "not-a-url"):
            self.assertEqual(throttle.wait(url), 0.0)


class ScraplingStatsAttributionTests(unittest.TestCase):
    def test_blocked_and_failed_fetches_are_attributed_to_their_host(self):
        # Regression: a run reported blocked=424 with no record of WHICH hosts
        # blocked it, because only the success paths recorded a domain.
        stats = scrape_stats = ScraplingStats()
        stats.record_blocked("https://kbdfans.com/products/a.json")
        stats.record_blocked("https://kbdfans.com/products/b.json")
        stats.record_failed("https://cannonkeys.com/products/c.json")
        self.assertEqual(scrape_stats.blocked_domains["kbdfans.com"], 2)
        self.assertEqual(scrape_stats.failed_domains["cannonkeys.com"], 1)
        summary = stats.problem_summary()
        # Worst offender ranks first so the log line leads with the real cause.
        self.assertTrue(summary.startswith("kbdfans.com blocked=2"), summary)
        self.assertIn("cannonkeys.com failed=1", summary)

    def test_problem_summary_is_empty_on_a_clean_run(self):
        stats = ScraplingStats()
        stats.record_domain("https://kbdfans.com/products/a.json")
        self.assertEqual(stats.problem_summary(), "")

    def test_problem_summary_caps_the_host_list(self):
        stats = ScraplingStats()
        for i in range(12):
            stats.record_blocked(f"https://host{i:02d}.test/x")
        summary = stats.problem_summary(limit=3)
        self.assertEqual(summary.count(";"), 3)  # 3 hosts + the "more" note
        self.assertIn("(+9 more host(s))", summary)


if __name__ == "__main__":
    unittest.main()
