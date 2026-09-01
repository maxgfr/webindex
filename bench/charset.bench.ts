import { bench, describe } from "vitest";
import { decodeBody } from "../src/charset.js";

// Body decoding at page scale. Run with `pnpm run bench`.

const chunk = Buffer.concat([Buffer.from("Une réponse déjà validée ", "latin1"), Buffer.from([0x97, 0x85, 0x80]), Buffer.from(" coûts. ", "latin1")]);
const cp1252_4m = Buffer.concat(Array.from({ length: Math.ceil(4_000_000 / chunk.length) }, () => chunk));
const utf8_4m = Buffer.from("Une réponse déjà validée — coûts. ".repeat(Math.ceil(4_000_000 / 40)), "utf8");

describe("decodeBody", () => {
  bench("windows-1252 (4 MB)", () => {
    decodeBody(cp1252_4m, "text/html; charset=windows-1252");
  });
  bench("utf-8 (4 MB)", () => {
    decodeBody(utf8_4m, "text/html; charset=utf-8");
  });
});
