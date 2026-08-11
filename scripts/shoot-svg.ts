/**
 * Screenshot local SVG files so a generated diagram can actually be looked at.
 *
 * Lives here because this project already has a browser installed. Takes file
 * paths, writes a PNG beside each one.
 */
import { chromium } from 'patchright';
import path from 'node:path';
import { readFileSync } from 'node:fs';

async function main() {
  const files = process.argv.slice(2);
  if (!files.length) throw new Error('Pass one or more file paths.');

  // Real Chrome — patchright ships no bundled chromium, and this project
  // installs the channel build for exactly this reason.
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });

  try {
    for (const file of files) {
      const absolute = path.resolve(file);
      // Size the viewport to the drawing and shoot that, rather than asking for
      // a full-page capture of a standalone SVG document — Chrome stalls on
      // those, having no page box to measure.
      const source = readFileSync(absolute, 'utf8');
      const width = Number(source.match(/width="(\d+(?:\.\d+)?)"/)?.[1] ?? 1200);
      const height = Number(source.match(/height="(\d+(?:\.\d+)?)"/)?.[1] ?? 900);

      await page.setViewportSize({ width: Math.ceil(width), height: Math.ceil(height) });
      await page.goto(`file:///${absolute.replace(/\\/g, '/')}`, { waitUntil: 'load' });
      await page.waitForTimeout(500);

      const out = absolute.replace(/\.svg$/i, '.png');
      await page.screenshot({ path: out });
      console.log(`${out}  (${width}x${height})`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('failed:', err?.message ?? err);
  process.exit(1);
});
