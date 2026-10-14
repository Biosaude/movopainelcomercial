import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdirSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const baselineUrl = process.env.DASHBOARD_BASELINE_URL ?? "http://127.0.0.1:3002";
const currentUrl = process.env.DASHBOARD_CURRENT_URL ?? "http://127.0.0.1:3000";
for (const url of [baselineUrl, currentUrl]) assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
    (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
});
mkdirSync("/tmp/movopainel-visual", { recursive: true });
try {
  for (const width of [1440, 390]) {
    const pages = await Promise.all(
      [baselineUrl, currentUrl].map(async (url) => {
        const page = await browser.newPage({ viewport: { width, height: 1100 } });
        // Compare existing dashboard rendering independently of an external map outage.
        await page.route("https://servicodados.ibge.gov.br/**", (route) => route.abort());
        await page.goto(url, { waitUntil: "networkidle" });
        await page.addStyleTag({ content: "header { position: static !important; }" });
        await page.waitForTimeout(3000);
        return page;
      }),
    );
    const cards = pages.map((page) => page.locator("main .rounded-xl.bg-card"));
    const count = await cards[0].count();
    assert.equal(await cards[1].count(), count, "All original dashboard cards preserved");
    // The final management card intentionally gains login/publication/history.
    for (let index = 0; index < count - 1; index++) {
      const baseline = cards[0].nth(index);
      const current = cards[1].nth(index);
      await Promise.all([baseline, current].map((card) => card.scrollIntoViewIfNeeded()));
      await Promise.all(pages.map((page) => page.waitForTimeout(2000)));
      assert.equal(
        await current.innerText(),
        await baseline.innerText(),
        `Text/KPIs differ for card ${index}, width ${width}`,
      );
      const images = await Promise.all(
        [baseline, current].map((card, side) =>
          card.screenshot({
            animations: "disabled",
            path: `/tmp/movopainel-visual/${width}-${index}-${side}.png`,
          }),
        ),
      );
      const diff = await pages[0].evaluate(
        async (sources) => {
          const pixels = await Promise.all(
            sources.map(async (source) => {
              const image = new Image();
              image.src = source;
              await image.decode();
              const canvas = document.createElement("canvas");
              canvas.width = image.width;
              canvas.height = image.height;
              const context = canvas.getContext("2d");
              context.drawImage(image, 0, 0);
              return {
                width: image.width,
                height: image.height,
                data: context.getImageData(0, 0, image.width, image.height).data,
              };
            }),
          );
          if (pixels[0].width !== pixels[1].width || pixels[0].height !== pixels[1].height)
            return { sameSize: false, ratio: 1 };
          let different = 0;
          for (let offset = 0; offset < pixels[0].data.length; offset += 4) {
            if (
              [0, 1, 2, 3].some(
                (channel) =>
                  Math.abs(pixels[0].data[offset + channel] - pixels[1].data[offset + channel]) > 8,
              )
            )
              different++;
          }
          return { sameSize: true, ratio: different / (pixels[0].width * pixels[0].height) };
        },
        images.map((buffer) => `data:image/png;base64,${buffer.toString("base64")}`),
      );
      // Allow only tiny rasterization differences in borders/shadows. Text and
      // geometry must match, with at most 0.1% materially different pixels.
      assert.ok(
        diff.sameSize && diff.ratio <= 0.001,
        `Visual rendering differs for card ${index}, width ${width}: ${JSON.stringify(diff)}`,
      );
    }
    console.log(
      `Visual regression passed: ${count - 1} original cards preserve text, dimensions and pixels (0.1% tolerance) at ${width}px.`,
    );
    await Promise.all(pages.map((page) => page.close()));
  }
} finally {
  await browser.close();
}
