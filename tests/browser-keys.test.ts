import { describe, expect, it } from "vitest";
import { UsageError } from "../src/cli-kit.js";
import { keyEventsFor, keyName, parseKey } from "../src/browser/keys.js";

describe("parseKey", () => {
  it.each([
    ["Enter", { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" }],
    ["Tab", { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 }],
    ["Escape", { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }],
    ["Backspace", { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 }],
    ["Delete", { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 }],
    ["ArrowUp", { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 }],
    ["ArrowDown", { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 }],
    ["ArrowLeft", { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 }],
    ["ArrowRight", { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 }],
    ["Home", { key: "Home", code: "Home", windowsVirtualKeyCode: 36 }],
    ["End", { key: "End", code: "End", windowsVirtualKeyCode: 35 }],
    ["PageUp", { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 }],
    ["PageDown", { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 }],
    ["Space", { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " }],
    ["F1", { key: "F1", code: "F1", windowsVirtualKeyCode: 112 }],
    ["F12", { key: "F12", code: "F12", windowsVirtualKeyCode: 123 }],
  ])("knows %s", (name, want) => {
    const k = parseKey(name);
    expect(k).toEqual({ ...want, modifiers: 0 });
  });

  it("matches names without regard to case, and takes the usual aliases", () => {
    expect(parseKey("enter").key).toBe("Enter");
    expect(parseKey("ESC").key).toBe("Escape");
    expect(parseKey("Return").key).toBe("Enter");
    expect(parseKey("pagedown").windowsVirtualKeyCode).toBe(34);
  });

  it("types single characters: letters, digits, punctuation and anything else", () => {
    expect(parseKey("a")).toEqual({ key: "a", code: "KeyA", windowsVirtualKeyCode: 65, text: "a", modifiers: 0 });
    expect(parseKey("Z")).toEqual({ key: "Z", code: "KeyZ", windowsVirtualKeyCode: 90, text: "Z", modifiers: 0 });
    expect(parseKey("7")).toEqual({ key: "7", code: "Digit7", windowsVirtualKeyCode: 55, text: "7", modifiers: 0 });
    expect(parseKey(".")).toEqual({ key: ".", code: "Period", windowsVirtualKeyCode: 190, text: ".", modifiers: 0 });
    expect(parseKey("@")).toEqual({ key: "@", code: "Digit2", windowsVirtualKeyCode: 50, text: "@", modifiers: 0 });
    expect(parseKey("é")).toEqual({ key: "é", code: "", windowsVirtualKeyCode: 0, text: "é", modifiers: 0 });
    expect(parseKey("😀").text).toBe("😀");
    expect(parseKey("+").key).toBe("+");
  });

  it("maps control characters to their keys", () => {
    expect(parseKey("\n").key).toBe("Enter");
    expect(parseKey("\r").key).toBe("Enter");
    expect(parseKey("\t").key).toBe("Tab");
  });

  it("adds modifier bits: Alt=1, Ctrl=2, Meta=4, Shift=8", () => {
    expect(parseKey("Alt+x").modifiers).toBe(1);
    expect(parseKey("Control+A").modifiers).toBe(2);
    expect(parseKey("Ctrl+a").modifiers).toBe(2);
    expect(parseKey("Meta+Shift+K").modifiers).toBe(12);
    expect(parseKey("Cmd+Enter").modifiers).toBe(4);
    expect(parseKey("Control+Alt+Meta+Shift+Tab").modifiers).toBe(15);
    expect(parseKey("Control++")).toMatchObject({ key: "+", modifiers: 2 });
  });

  it("drops the text of a chord (Ctrl+A selects, it does not type an a), and shifts letters", () => {
    expect(parseKey("Control+A").text).toBeUndefined();
    expect(parseKey("Shift+a")).toEqual({ key: "A", code: "KeyA", windowsVirtualKeyCode: 65, text: "A", modifiers: 8 });
    expect(parseKey("Shift+Enter")).toMatchObject({ key: "Enter", text: "\r", modifiers: 8 });
  });

  it("rejects unknown names and malformed chords as usage errors", () => {
    for (const bad of ["Foo", "F13", "", "Control+", "+a", "Hyper+A", "Control+Foo"]) {
      expect(() => parseKey(bad), bad).toThrow(UsageError);
    }
    expect(() => parseKey("Entr")).toThrow(/unknown key "Entr"/);
  });
});

describe("keyName", () => {
  it("names a parsed key canonically, modifiers first", () => {
    expect(keyName(parseKey("ctrl+shift+enter"))).toBe("Control+Shift+Enter");
    expect(keyName(parseKey("return"))).toBe("Enter");
    expect(keyName(parseKey("Meta+Alt+k"))).toBe("Alt+Meta+k");
  });
});

describe("keyEventsFor", () => {
  it("sends keyDown with the text, then keyUp, for a key that types", () => {
    expect(keyEventsFor(parseKey("a"))).toEqual([
      { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, text: "a", unmodifiedText: "a", modifiers: 0 },
      { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 0 },
    ]);
  });

  it("sends rawKeyDown without text for a key that does not type", () => {
    expect(keyEventsFor(parseKey("Escape"))).toEqual([
      { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27, modifiers: 0 },
      { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27, modifiers: 0 },
    ]);
  });

  it("holds the modifiers down around the key and releases them in reverse", () => {
    const seq = keyEventsFor(parseKey("Control+Shift+K"));
    expect(seq.map((e) => `${e.type} ${e.key} ${e.modifiers}`)).toEqual([
      "rawKeyDown Control 2",
      "rawKeyDown Shift 10",
      "rawKeyDown K 10",
      "keyUp K 10",
      "keyUp Shift 2",
      "keyUp Control 0",
    ]);
    expect(seq[0]).toMatchObject({ code: "ControlLeft", windowsVirtualKeyCode: 17, location: 1 });
  });

  it("keeps a shifted letter's text", () => {
    const seq = keyEventsFor(parseKey("Shift+b"));
    expect(seq.map((e) => `${e.type} ${e.key} ${e.text ?? ""}`)).toEqual(["rawKeyDown Shift ", "keyDown B B", "keyUp B ", "keyUp Shift "]);
  });
});
