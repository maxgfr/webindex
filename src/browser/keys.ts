// Key names → Input.dispatchKeyEvent parameters.
//
// A page reads `key`, `code` and `keyCode` off a keyboard event, and a handler
// that checks only one of them is common ("keyCode === 13"), so all three are
// filled in, from a US layout. The event sequence is the one a real keyboard
// produces: modifiers go down first and come up last, and a key that types
// something is sent as `keyDown` with its text (the browser derives the
// keypress and the insertion from it), any other key as `rawKeyDown`.

import { UsageError } from "../cli-kit.js";

export interface KeySpec {
  /** `KeyboardEvent.key`: "Enter", "a", "A", " ". */
  key: string;
  /** `KeyboardEvent.code`, the physical key: "Enter", "KeyA", "Space"; "" for a character no key types. */
  code: string;
  windowsVirtualKeyCode: number;
  /** What the key types; absent for keys that type nothing and for chords with Control, Alt or Meta. */
  text?: string;
  /** CDP modifier bits: Alt=1, Ctrl=2, Meta=4, Shift=8. */
  modifiers: number;
}

/** One `Input.dispatchKeyEvent` call. */
export interface KeyEvent {
  type: "keyDown" | "rawKeyDown" | "keyUp";
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  nativeVirtualKeyCode: number;
  text?: string;
  unmodifiedText?: string;
  modifiers: number;
  location?: number;
}

const ALT = 1;
const CTRL = 2;
const META = 4;
const SHIFT = 8;

interface Named {
  key: string;
  code: string;
  vk: number;
  text?: string;
}

/** The modifier keys, in bit order: the order they are pressed and named in. */
const MODIFIERS: [bit: number, spec: Named, aliases: string[]][] = [
  [ALT, { key: "Alt", code: "AltLeft", vk: 18 }, ["alt", "option", "opt"]],
  [CTRL, { key: "Control", code: "ControlLeft", vk: 17 }, ["control", "ctrl"]],
  [META, { key: "Meta", code: "MetaLeft", vk: 91 }, ["meta", "cmd", "command", "super", "win"]],
  [SHIFT, { key: "Shift", code: "ShiftLeft", vk: 16 }, ["shift"]],
];

const NAMED = new Map<string, Named>();
const name = (n: Named, ...aliases: string[]) => {
  for (const a of [n.key, ...aliases]) NAMED.set(a.toLowerCase(), n);
};
name({ key: "Enter", code: "Enter", vk: 13, text: "\r" }, "Return");
name({ key: "Tab", code: "Tab", vk: 9 });
name({ key: "Escape", code: "Escape", vk: 27 }, "Esc");
name({ key: "Backspace", code: "Backspace", vk: 8 });
name({ key: "Delete", code: "Delete", vk: 46 }, "Del");
name({ key: "Insert", code: "Insert", vk: 45 });
name({ key: "ArrowUp", code: "ArrowUp", vk: 38 }, "Up");
name({ key: "ArrowDown", code: "ArrowDown", vk: 40 }, "Down");
name({ key: "ArrowLeft", code: "ArrowLeft", vk: 37 }, "Left");
name({ key: "ArrowRight", code: "ArrowRight", vk: 39 }, "Right");
name({ key: "Home", code: "Home", vk: 36 });
name({ key: "End", code: "End", vk: 35 });
name({ key: "PageUp", code: "PageUp", vk: 33 });
name({ key: "PageDown", code: "PageDown", vk: 34 });
name({ key: " ", code: "Space", vk: 32, text: " " }, "Space");
for (let i = 1; i <= 12; i++) name({ key: `F${i}`, code: `F${i}`, vk: 111 + i });
for (const [, spec, aliases] of MODIFIERS) name(spec, ...aliases);

/** US-layout punctuation: the key that types it, and that key's virtual key code. */
const PUNCT: Record<string, [code: string, vk: number]> = {};
const punct = (chars: string, code: string, vk: number) => {
  for (const c of chars) PUNCT[c] = [code, vk];
};
punct("-_", "Minus", 189);
punct("=+", "Equal", 187);
punct("[{", "BracketLeft", 219);
punct("]}", "BracketRight", 221);
punct("\\|", "Backslash", 220);
punct(";:", "Semicolon", 186);
punct("'\"", "Quote", 222);
punct(",<", "Comma", 188);
punct(".>", "Period", 190);
punct("/?", "Slash", 191);
punct("`~", "Backquote", 192);
")!@#$%^&*(".split("").forEach((c, i) => punct(c, `Digit${i}`, 48 + i));

/** A single character as the key that types it. Characters no US key types still type, with no code. */
function charKey(c: string): Named {
  if (c === "\n" || c === "\r") return NAMED.get("enter") as Named;
  if (c === "\t") return NAMED.get("tab") as Named;
  if (c === " ") return NAMED.get(" ") as Named;
  if (/^[a-z]$/i.test(c)) return { key: c, code: `Key${c.toUpperCase()}`, vk: c.toUpperCase().charCodeAt(0), text: c };
  if (/^[0-9]$/.test(c)) return { key: c, code: `Digit${c}`, vk: c.charCodeAt(0), text: c };
  const p = PUNCT[c];
  return p ? { key: c, code: p[0], vk: p[1], text: c } : { key: c, code: "", vk: 0, text: c };
}

const isChar = (s: string): boolean => [...s].length === 1;

function modifierBit(raw: string): number {
  const hit = MODIFIERS.find(([, , aliases]) => aliases.includes(raw.toLowerCase()));
  if (!hit) throw new UsageError(`unknown modifier "${raw}" — use Control, Alt, Meta or Shift`);
  return hit[0];
}

/**
 * "Enter", "Tab", "ArrowDown", "F5", "a", "é", "Control+A", "Meta+Shift+K"…
 * Named keys match without regard to case; a single character is typed as is.
 * Throws UsageError on anything else.
 */
export function parseKey(input: string): KeySpec {
  if (isChar(input)) return toSpec(charKey(input), 0);
  const parts = input.split("+");
  // "Control++": the key is "+" itself.
  if (parts.length > 2 && parts.at(-1) === "" && parts.at(-2) === "") parts.splice(-2, 2, "+");
  const last = parts.pop() as string;
  let mods = 0;
  for (const m of parts) mods |= modifierBit(m);
  if (last === "") throw new UsageError(`missing key in "${input}" — e.g. Control+A`);
  const named = isChar(last) ? charKey(last) : NAMED.get(last.toLowerCase());
  if (!named) throw new UsageError(`unknown key "${last}" — use a single character or a name such as Enter, Tab, Escape, ArrowDown, PageUp, F1…F12`);
  return toSpec(named, mods);
}

function toSpec(n: Named, modifiers: number): KeySpec {
  let { key, text } = n;
  // Shift turns a letter into its capital; Control, Alt and Meta make a chord that types nothing.
  if (modifiers & SHIFT && /^[a-z]$/.test(key)) key = text = key.toUpperCase();
  if (modifiers & (CTRL | ALT | META)) text = undefined;
  return { key, code: n.code, windowsVirtualKeyCode: n.vk, ...(text !== undefined ? { text } : {}), modifiers };
}

/** The canonical name of a key: "Control+Shift+Enter". What the irreversibility guard is shown. */
export function keyName(spec: KeySpec): string {
  const mods = MODIFIERS.filter(([bit]) => spec.modifiers & bit).map(([, m]) => m.key);
  return [...mods, spec.key === " " ? "Space" : spec.key].join("+");
}

/** The Input.dispatchKeyEvent calls that press and release `spec`, its modifiers around it. */
export function keyEventsFor(spec: KeySpec): KeyEvent[] {
  const held = MODIFIERS.filter(([bit]) => spec.modifiers & bit);
  const out: KeyEvent[] = [];
  let mods = 0;
  for (const [bit, m] of held) {
    mods |= bit;
    out.push({ type: "rawKeyDown", key: m.key, code: m.code, windowsVirtualKeyCode: m.vk, nativeVirtualKeyCode: m.vk, modifiers: mods, location: 1 });
  }
  const base = { key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.windowsVirtualKeyCode, nativeVirtualKeyCode: spec.windowsVirtualKeyCode };
  out.push(
    spec.text !== undefined
      ? { type: "keyDown", ...base, text: spec.text, unmodifiedText: spec.text, modifiers: mods }
      : { type: "rawKeyDown", ...base, modifiers: mods },
  );
  out.push({ type: "keyUp", ...base, modifiers: mods });
  for (const [bit, m] of [...held].reverse()) {
    mods &= ~bit;
    out.push({ type: "keyUp", key: m.key, code: m.code, windowsVirtualKeyCode: m.vk, nativeVirtualKeyCode: m.vk, modifiers: mods, location: 1 });
  }
  return out;
}
