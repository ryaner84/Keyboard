from __future__ import annotations

import sys
import unittest
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


if __name__ == "__main__":
    unittest.main()
