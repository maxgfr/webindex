import { bench, describe } from "vitest";
import { extractMainHtml, htmlToText } from "../src/fetch.js";
import { pageMetadata } from "../src/structured.js";
import { extractTables } from "../src/tables.js";

// HTML extraction at page scale, on a synthetic ~2 MB page with the usual
// furniture (nav, sidebar, footer, a table). Run with `pnpm run bench`.

const article = Array.from(
  { length: 4_000 },
  (_, i) =>
    `<h2>Section ${i}</h2><p>A token bucket refills at a <b>fixed rate</b> and caps at its burst size. Each request removes one token from the bucket &mdash; see <a href="/s/${i}">section ${i}</a>.</p>`,
).join("\n");
const table = `<table><thead><tr><th>Name</th><th>Rate</th></tr></thead><tbody>${Array.from({ length: 2_000 }, (_, i) => `<tr><td>row ${i}</td><td>${i}</td></tr>`).join("")}</tbody></table>`;
const page2m = `<!doctype html><html><head><title>Rate limiting</title><meta name="description" content="Token buckets"><meta property="og:title" content="Rate limiting"><script type="application/ld+json">{"@type":"Article","headline":"Rate limiting"}</script></head><body><nav>${"<a href='/x'>nav</a>".repeat(50)}</nav><main><article>${article}${table}</article></main><aside>${"<a href='/y'>related</a>".repeat(100)}</aside><footer>${"<span>footer</span>".repeat(50)}</footer></body></html>`;

describe(`html extraction (${(page2m.length / 1e6).toFixed(1)} MB page)`, () => {
  bench("extractMainHtml", () => {
    extractMainHtml(page2m);
  });
  bench("htmlToText", () => {
    htmlToText(page2m);
  });
  bench("extractTables", () => {
    extractTables(page2m);
  });
  bench("pageMetadata", () => {
    pageMetadata(page2m);
  });
});
