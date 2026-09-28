import { deflateRawSync } from "node:zlib";

// A minimal ZIP writer for the office-reader tests: local headers, a central
// directory and its end record — enough to build a package that breaks exactly
// one of the reader's rules. CRCs are left 0; the reader never checks them.

export interface ZipEntry {
  data: string | Buffer;
  /** 0 stored, 8 deflate (the default), anything else to test a refusal. */
  method?: number;
  /** General-purpose flags; bit 0 marks the entry encrypted. */
  flags?: number;
}

export function zip(entries: Record<string, string | Buffer | ZipEntry>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const all = Object.entries(entries);
  for (const [name, spec] of all) {
    const e: ZipEntry = typeof spec === "string" || Buffer.isBuffer(spec) ? { data: spec } : spec;
    const data = Buffer.from(e.data);
    const method = e.method ?? 8;
    const body = method === 8 ? deflateRawSync(data) : data;
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(e.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(e.flags ?? 0, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBytes.length, 28);
    dir.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body);
    central.push(dir, nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(all.length, 8);
  end.writeUInt16LE(all.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

/** A .docx whose body is `body` (WordprocessingML), plus any `extra` entries (which may replace the document). */
export function docx(body: string, extra: Record<string, string | Buffer | ZipEntry> = {}): Buffer {
  return zip({
    "[Content_Types].xml": "<Types/>",
    "_rels/.rels":
      '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/document.xml": `<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`,
    ...extra,
  });
}
