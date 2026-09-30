// Near-duplicate frames, told apart with no dependency.
//
// A slide held for two minutes trips the scene detector every time the
// speaker's hand crosses it, and a chapter start often lands on a frame the
// detector already took. dHash (difference hash) catches both: shrink the
// image to 9×8 grey pixels — ffmpeg does that, so no image decoder is needed
// here — and set one bit per pixel that is brighter than its right-hand
// neighbour. Two frames whose 64-bit hashes differ in at most a handful of
// bits show the same thing.

/** Bytes in one 9×8 grey frame, as `ffmpeg -vf scale=9:8,format=gray -f rawvideo` writes it. */
export const DHASH_FRAME_BYTES = 72;

/** Hashes at most this many bits apart show the same picture. */
export const DHASH_SAME = 6;

/** The 64-bit dHash of one 9×8 grey frame. */
export function dhash(gray: Uint8Array): bigint {
  if (gray.length < DHASH_FRAME_BYTES) throw new Error(`dhash needs ${DHASH_FRAME_BYTES} bytes, got ${gray.length}`);
  let h = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      h = (h << 1n) | (gray[y * 9 + x]! > gray[y * 9 + x + 1]! ? 1n : 0n);
    }
  }
  return h;
}

/** How many bits two hashes differ in. */
export function hamming(a: bigint, b: bigint): number {
  let x = a ^ b;
  let n = 0;
  while (x) {
    x &= x - 1n;
    n++;
  }
  return n;
}

/** Every frame in a raw stream of 9×8 grey frames, hashed in order. */
export function dhashStream(raw: Uint8Array): bigint[] {
  const out: bigint[] = [];
  for (let at = 0; at + DHASH_FRAME_BYTES <= raw.length; at += DHASH_FRAME_BYTES) out.push(dhash(raw.subarray(at, at + DHASH_FRAME_BYTES)));
  return out;
}
