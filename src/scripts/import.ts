// Local importer: pulls real GMK sets from KeycapLendar and refreshes prices.
// Run with: npm run import
import "dotenv/config";
import { importGmkSets } from "../lib/import/keycaplendar";
import { refreshPrices } from "../lib/import/prices";

async function main() {
  console.log("Importing GMK sets from KeycapLendar...");
  const importResult = await importGmkSets();
  console.log(
    `Imported ${importResult.sets} sets, ${importResult.vendors} vendors, ${importResult.vendorKits} vendor listings.`
  );

  const limit = Number(process.env.PRICE_LIMIT ?? "5000");
  console.log(`Refreshing up to ${limit} vendor prices...`);
  // Local run: no serverless limit, so give it plenty of time to finish.
  const priceResult = await refreshPrices({ limit, maxAgeHours: 0, maxRuntimeMs: 10 * 60_000 });
  console.log(
    `Prices: attempted ${priceResult.attempted}, updated ${priceResult.updated}, failed ${priceResult.failed}` +
      (priceResult.stoppedEarly ? " (stopped early — time budget hit)" : "") +
      "."
  );

  console.log("Done.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => process.exit(0));
