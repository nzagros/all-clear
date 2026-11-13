// Renders the infographic views to PNG with a local Chromium-based browser (Playwright).
// Usage: node assets/src/render.mjs   (writes assets/*.png and .claude-plugin/icon.png)
import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const page_url = pathToFileURL(path.join(here, 'infographic.html')).href;
const jobs = [
  ['banner', 'light', 1600, 700, 'assets/banner-light.png'],
  ['banner', 'dark', 1600, 700, 'assets/banner-dark.png'],
  ['flow', 'light', 1600, 1260, 'assets/how-it-works-light.png'],
  ['flow', 'dark', 1600, 1260, 'assets/how-it-works-dark.png'],
  ['icon', 'light', 1024, 1024, '.claude-plugin/icon.png'],
];
const browser = await chromium.launch({ channel: 'msedge' }).catch(() => chromium.launch());
for (const [view, theme, width, height, out] of jobs) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.goto(`${page_url}?view=${view}&theme=${theme}`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(root, out), clip: { x: 0, y: 0, width, height } });
  await page.close();
  console.log('wrote', out);
}
await browser.close();
