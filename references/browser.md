# The browser

`webindex browser` drives a real Chrome, Brave, Chromium or Edge over the
DevTools Protocol, one action per command. It is a **separate** browser on a
dedicated profile, never the user's own, launched with no automation flags. You
see each page as an accessibility snapshot with refs and act on those refs. The
human signs in and solves challenges in its window, and you take it from there.

## When to use it

- **A page only JavaScript fills**: `fetch` returns a shell or almost no text.
  `webindex fetch <url> --browser` is enough when you only need to read it.
- **A session the human opened**: an account page, an intranet, anything behind
  a login they did in the dedicated browser.
- **A site that refuses plain HTTP** (403, 429) but serves a real browser.
- **A JSON API behind a page**: record what it fetches (`--capture`), often
  cleaner data than the HTML.

Use plain `fetch` everywhere else: it is faster and needs no browser.

## The loop

1. `webindex browser open <url> --snapshot` loads the page, launching the browser
   on first use, and prints the tree. A page that committed but has not loaded
   within 30 s (`--timeout <ms>`: a cold server, a render-blocking script that
   holds even DOMContentLoaded) is opened all the same, with a `still loading after
   … ms` note: take a snapshot, or `wait --load`. So is one `back`, `forward` or
   `reload` lands on. One that never committed fails.
2. Read the snapshot. Each element you can act on carries a ref: `button "Search" [ref=e12]`.
3. Act on one ref: `click e12`, `fill e7 "text"`, `select e9 Beta`, `upload e11 cv.pdf`,
   `press Escape`. Add `--snapshot` to get the new tree in the same call, and
   `--selector <css>` with it to get only that element's subtree
   (`press Enter --snapshot --selector .results`). The selector only scopes the
   snapshot: what the action acts on is always the ref (or the focus).
   `fill` and `type` echo what the field holds afterwards (`value: "Jane Doe"`,
   as an input mask may have reformatted it), and `select` the options chosen; a
   password field's value is never echoed (`value: (hidden)`).
4. Check the result with `wait --text "Results"`, `wait --url /done` or `wait --idle`,
   then take a new snapshot before the next act.

`snapshot --interactive` (and `open <url> --snapshot --interactive`) lists only
the controls and is much shorter. `snapshot e40` shows one subtree, and so does
`snapshot --selector <css>` for the first element a CSS selector matches.
`--max-chars <n>` cuts a snapshot at a line (20000 characters by default) and
says how many lines it left out. Same-origin iframes are expanded.

A form control with no name, or with the name another one has, cannot be told
apart by its line, so it gets its element's `type`, `name` and `placeholder`
(its `id` when it has no `name`) after its ref. Two `<label>`s for one field
make that common:

```
- textbox "Username Password" [ref=e5]
- textbox [ref=e6] (type=password, name="password")
```

Its value is never shown. A snapshot hints 50 controls at most.

## Reading the page

`browser text` prints what the current tab says, loading nothing: its main
content, as `fetch` reads a page (navigation and boilerplate left out), from a
copy without the overlays, dialogs and consent panels, so a cookie wall over
the page is not what comes back and needs no answer. `text e40` or
`text --selector article` reads one element instead: its text as the page
shows it. `--markdown` keeps headings, links and lists; `--max-chars <n>` cuts
it (20000 by default) with a `[truncated at …]` line. Use it to read an article
or a list of results; `eval` with a guessed selector is not needed for that.

`screenshot` takes the viewport, the full page (`--full`), one element by its
ref (`screenshot e40`), or the first element a CSS selector matches
(`screenshot --selector table.infobox`), captured whole even when it is taller
than the window. A selector that matches nothing fails with exit 1,
`no element matches <css>`.

## Overlays and consent walls

What covers the page comes first in a snapshot, under its own header, and is
not repeated in the tree below it:

```
- overlay (covers the page):
  - dialog "Vos choix"
    - button "Accepter et continuer" [ref=e1]
    - button "Refuser" [ref=e2]
- banner
  ...
```

An overlay is one of these, shown on screen (no ancestor hidden, transparent,
`aria-hidden` or `inert`):

- a dialog (`role="dialog"` or `alertdialog`, `aria-modal`, an open `<dialog>`)
  that is out of the flow of the page (fixed or absolute positioning: one in
  the flow covers nothing, whatever its markup says);
- a consent vendor's container (OneTrust, Didomi, Cookiebot…), whatever its size;
- a **fixed** layer (itself or an ancestor; sticky is layout) over at least 30%
  of the viewport, wide (60%) or strictly across its middle, and on top at its
  centre. A layer that holds the `main` landmark or most of the page's text is
  the page itself (an app shell): neither it nor anything inside it counts,
  except a dialog. A presentational root (`role="presentation"`) is looked
  through to the dialog inside it.

One that is **bare** is no overlay: no control in it (a link, a button, a
field, anything focusable or editable, an iframe) and under 40 characters of
text. A consent vendor's container is never bare (its buttons may be plain
`div`s), and neither is a layer holding a web component whose shadow root is
closed (its text and controls cannot be seen from outside). An ad slot fixed over the page with only an image in it
covers part of the screen but asks nothing: it is not listed under the header,
and a click it covers is refused as for a sticky header, with no consent wording.

Only the outermost overlay counts. A `--max-chars` cut never drops it, even
when the page appends it at the end of `<body>`. A click that lands on one is
refused (exit 1) with the overlay's controls and their refs, which you can use
in the next command. A click blocked by something that is no overlay (a sticky
header, a chat bubble) is refused with what is in the way and its controls.

**Ask the user before accepting tracking or consent.** "Accept", "Refuse",
"Customise" and "Close" are the user's choices, not yours, even though the guard
does not stop them. Tell the user what the overlay asks, and click the answer they
pick. `fetch --browser` never needs an answer: it reads a copy of the page
without its overlays, dialogs and consent panels (OneTrust, Didomi, Sourcepoint,
Quantcast, Cookiebot, Usercentrics, TrustArc and the like). The copy is parsed
apart from the page, so nothing on the page runs or changes. `--full-page` reads
everything.

## Refs

- **What gets a ref**: what you act on (links, buttons, fields, options,
  headings, iframes, anything focusable or editable), and the structural
  containers you may want to scope a snapshot or a screenshot to: `table`,
  `figure`, `article`, `main`, `complementary`, `form`, and a `region` or an
  `image` that has a name. `--interactive` lists only the first kind. A
  container's ref is refused by `click` (exit 2): whatever sits at its centre
  is what would be pressed, so click a control inside it. Anything else (a
  `div` with a class) is reached with `--selector <css>` on `snapshot`,
  `screenshot` and `text`, and on an action's `--snapshot`. An action without
  `--snapshot` refuses `--selector` (exit 2): it would act on the ref anyway.
- **`eN` is the element's `backendDOMNodeId`**, kept in `refs/<tab>.json`. A
  ref is stable while its element node lives: a later snapshot of the same
  document hands the same element the same `eN`. A widget the page re-renders
  (a time input's spinbuttons after a `fill`, a list a framework redraws) is
  new nodes with new refs, and the old ones go stale. Take a new snapshot after
  acting on one.
- **A ref goes stale when the tab loads another document.** An action on it then
  fails with exit 1: `ref "e12" is unknown or stale: take a new snapshot and
  use the refs it returns`. Take one and use its refs. Never guess a ref.
- **A ref is `e` and a number.** Anything else (a CSS selector such as
  `table.infobox`) is a usage error, exit 2: `expected a ref like e12 from the
  latest snapshot; CSS selectors: use --selector (screenshot, snapshot, text, wait)`.
- **A click is a real mouse press** at the element's centre, refused when
  something covers that point (a cookie banner). The error names it, and lists
  the controls of the overlay it belongs to, with refs.

## Safety rules

- **Ask the user before anything irreversible**: paying, ordering, deleting,
  publishing, sending, validating, subscribing, booking. A click or an Enter whose
  label looks like one of these (French and English) is refused with exit 1, and
  so is submitting a form that holds a password field. Retry with `--confirm`
  (`confirm: true` over MCP) only after the user has said yes to that very
  action. The guard is a safety net. It does not replace asking. It follows the
  focus into shadow roots and same-origin frames. A click on a frame, or one
  that lands on another origin's frame (a PayPal or Google Pay button is one),
  is refused: its content cannot be inspected. Click the element inside a
  same-origin frame instead, and ask the user before confirming the other kind.
  Over MCP, accepting a dialog whose message looks irreversible ("Supprimer
  définitivement ?") needs `confirm: true` too; dismissing never does.
- **What the guard does not see**: Enter in a textarea, a contenteditable or a
  chat box with no form around it, and a `select` that submits on change, are
  not guarded. Ask first when one of those would send or commit something.
- **The human logs in and solves challenges** in the visible window. When
  `open` reports `challenge: cloudflare (blocking)` it exits 3 (so does `back`,
  `forward`, `reload`, a `click`, `press`, `type --submit` or `tabs new <url>` that lands on one),
  with the result printed as on success and `challenge` in its JSON. Tell the
  user, then run `wait --clear`, which waits up to 5 minutes for the wall to go
  and holds the browser all that time. **Unattended** (no one at the window, a
  headless browser), do not wait the 5 minutes: pass a short `--timeout`, or
  skip the wait, and tell the user the page needs them. A consent wall is no
  challenge: `browser text` and `fetch --browser` read the page behind it. After
  a login, run `wait --url <pattern>`. Do not log in for the user.
- **No anti-bot bypass of any kind**: no stealth patches, no captcha solvers,
  no fingerprint spoofing. A challenge is named and left to the human.
- **`eval` runs in the logged-in page.** Read with it. Never use it to do what
  the guard would refuse, such as `el.click()` on a pay button.
- **MCP uploads** stay under `--extract-root`; with none, they need
  `confirm: true` after the user approves the exact files.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | done |
| 1 | ran and failed: a stale ref, a timeout, a guard refusal, a selector that matches nothing, a page error |
| 2 | the invocation was wrong: a missing argument, an unknown flag, a CSS selector where a ref goes |
| 3 | done, and a human is needed: a navigation (`open`, `back`, `forward`, `reload`, a `click`, `press`, `type --submit`, `tabs new <url>`) ended on a blocking challenge |

Over MCP there are no exit codes: the same result is no error, and a
`challenge: … (blocking)` line follows the result line.

## Profiles and the launch policy

The profile lives in `~/.webindex/browser/profiles/<name>` (`--profile <n>`,
`default` otherwise). The browser home is `WEBINDEX_BROWSER_DIR`. Its
directories are 0700 and its files 0600: it holds logins. A login made there
lasts across runs. `profile import <chrome|brave|chromium|edge|path>` copies an
existing browser's session in once. It refuses a source that is running and a
target that exists unless `--force`. Cookies are encrypted per browser kind, so
import from the same browser you run: a Brave profile under Chrome reads as
logged out. So a profile belongs to one kind of browser: the kind it is imported
from or first launched with, recorded in the profile. Launching another kind on
it fails and suggests another profile (`--profile brave`). `profile reset` deletes
a profile, `profile path` prints it.

Each command finds its browser in this order:

1. **An explicit port**: `--cdp <port|url>` or `attach <port|url>`, loopback
   only, its WebSocket included. A browser you attach to is never closed, only
   forgotten.
2. **The saved session**: if the browser named in `session.json` still answers,
   on the same tab. A browser you attached to is reused only when no
   `--profile` is given: `--profile default` means the dedicated browser.
3. **A new browser**, started with `--remote-debugging-port=0` and
   `--user-data-dir` set to the profile, reading the real port from
   `DevToolsActivePort`. It is headed unless `--headless`. A headless window has
   nowhere for a human to solve a challenge. Which browser: `WEBINDEX_BROWSER_BIN`,
   else the kind `open --browser-kind chrome|brave|chromium|edge` names, else
   `WEBINDEX_BROWSER_KIND`, else the profile's own kind, else the first of Chrome,
   Brave, Chromium and Edge found. A kind named (or the profile's own) is that
   kind or an error saying it is not installed, never another browser.

There is no daemon: each command reconnects through `session.json`, so the tab
and its refs carry over. A cross-process lock runs commands one at a time, and
one that waits over 10 s fails "browser busy". `wait --clear` holds the lock
while the human works, for minutes. `close` shuts down only a browser
webindex launched, after checking it is the same process, and that includes one
a `fetch` read started. `status` and `close` never launch anything.

## Reading pages through `fetch`

`fetch --browser`, or `WEBINDEX_BROWSER_FETCH=always`, renders every web page in
the dedicated browser. `fallback` does it only when the plain read was refused
(401, 403, 429, 503, no answer), or returned junk or under 200 characters. PDFs,
office documents and videos never go to the browser, and neither do MCP
servers run with `--public-only` or `--allow-remote`. A browser you attached to
is never used for these reads: they go to the dedicated browser unless `cdp`
names one. When no browser is running, the read launches the **same headed
browser** `browser open` would, so a window appears. That shared profile is
where the human can solve a challenge. Each read uses a scratch tab that is
closed afterwards, so your agent tab is left alone. An error page (HTTP 400 or
higher) never counts as a browser read. Downloads are denied while a read runs,
and `WEBINDEX_BROWSER_CONCURRENCY` limits how many pages render at once.

A library consumer should call `closeBrowserReads()` at the end of its run. It
closes the browser only if a read in that same process launched it, after the
reads still in flight there finish (5 s at most), and resolves `{ closed: false }`
for any other browser: one `browser open` started or took over, or one you attached.

## Ad blocking

Ads and trackers slow pages down and put more overlays in the way. Two ways to
block them in the dedicated browser:

- **Brave**, which blocks ads and trackers on its own (Shields), and hides many
  cookie notices too: `WEBINDEX_BROWSER_KIND=brave`, or
  `browser open <url> --browser-kind brave`. Give it a profile of its own
  (`--profile brave`) if the default one was made with Chrome.
- **An unpacked extension**, such as uBlock Origin Lite: download the Chromium
  zip of a release on github.com/uBlockOrigin/uBOL-home, unzip it, and name the folder that holds
  `manifest.json`: `WEBINDEX_BROWSER_EXTENSIONS=/abs/path/uBOLite`. Several are
  comma separated. They are loaded, and every other extension kept off, only when
  webindex launches the browser: `close` a running one first. Chromium, Brave
  and Chrome for Testing load them. **Branded Google Chrome 137 and later
  ignores them**, so none is passed to it: `open` says so in a `note:` line (and
  in `notes` with `--json`), `doctor` too, and both point at the others.

`doctor` shows the kind asked for and the extensions it would load.

## Network capture

`open <url> --capture` (or `--capture` on any action) records the JSON
responses the page fetches (XHR and fetch) while that command runs: pass it to
every command whose fetches you want, such as each `scroll bottom --capture` of
an infinite list. What is recorded goes to the tab's log, which keeps growing
across commands until `network clear`. Each command says both counts:
`captured 10 JSON responses (30 in the log)`; under `WEBINDEX_NO_WRITE` nothing
reaches the log, and only the first count is said. `network list` numbers the
entries, `network get <n>` prints one body as JSON, and `network clear` empties
the log. Headers are never stored. URLs keep their
query strings, and request bodies (`postData`, up to 4 KiB) are stored raw, so a
recorded login POST can hold the password. Clear the log after a session where
that matters.

## Accepted limits

- **Cross-origin iframes** (out-of-process) are not expanded in the snapshot.
- **In the CLI, recording and dialogs last only one command.** `--capture`
  records only while the command it is given to runs (the log it writes to
  stays, see above), and the browser hands a dialog only to the connection
  that saw it open. So a dialog a page opens
  while a command runs (on a click, on load, a "Leave site?" on reload) is
  dismissed as it opens, never accepted, and the result says so. A dismissed
  beforeunload cancels the reload or navigation, which then fails at once.
  `dialog accept|dismiss` is for the MCP tools; the CLI refuses it. A dialog the
  page opens between commands freezes the tab, and the next command fails after
  5 s with "the tab does not answer; most likely a JavaScript dialog the page
  opened between commands". Answer it in the window, or run `close`; headless,
  `close` is the only way out.
- **`snapshot` reads the whole accessibility tree**: slow on huge pages.
- **The debug port is open to every local process** for as long as the browser
  runs. `close` ends it.

## Environment

| Variable | What it sets |
|---|---|
| `WEBINDEX_BROWSER_DIR` | the browser home (default `~/.webindex/browser`) |
| `WEBINDEX_BROWSER_BIN` | the browser binary, instead of the first one found |
| `WEBINDEX_BROWSER_KIND` | `chrome`, `brave`, `chromium` or `edge`: the kind launched when no binary is named, and no other (`open --browser-kind` wins) |
| `WEBINDEX_BROWSER_EXTENSIONS` | unpacked extensions to load when webindex launches the browser: absolute folders holding a `manifest.json`, comma separated |
| `WEBINDEX_BROWSER_FETCH` | `always`, `fallback` or `off` (default): whether `fetch` renders pages in the browser |
| `WEBINDEX_BROWSER_CONCURRENCY` | pages the fetch rung renders at once (default 1, at most 4) |
| `WEBINDEX_BROWSER_TIMEOUT_MS` | how long the fetch rung gives one page (default 30000) |

## Over MCP

`webindex mcp --browser` adds 20 tools over one session that lives as long as
the server, so captures and dialogs persist across calls: a dialog stays open,
and the page tools are refused, until `webindex_browser_dialog` answers it.
They are refused with `--allow-remote` or `--public-only`: a logged-in browser
here is for this machine alone. Waits are capped at 300 s and stop on cancel.
Tools that change the page return the snapshot taken after them.

| CLI | MCP tool |
|---|---|
| `open <url>` (`--new-tab`, `--capture`, `--profile`, `--headless`, `--browser-kind`) | `webindex_browser_open` (`browserKind`) |
| `snapshot [<ref>]` (`--interactive`, `--selector`) | `webindex_browser_snapshot` (`mode` required, `ref` or `selector`) |
| `text [<ref>]` (`--selector`, `--markdown`, `--max-chars`) | `webindex_browser_text` (`scope` required: `page`, or `element` with `ref` or `selector`; `markdown`, `maxChars`) |
| `click`, `hover`, `type`, `fill`, `select`, `press`, `upload`, `scroll` | `webindex_browser_<same name>` |
| `wait --text\|--gone\|--selector\|--url\|--load\|--idle\|--clear\|--ms` | `webindex_browser_wait` (`condition`, `value`) |
| `screenshot [<ref>]` (`--full`, `--selector`) | `webindex_browser_screenshot` (`area` required, `ref` or `selector` with `element`; JPEG, 4 MB at most) |
| `eval <expr>` | `webindex_browser_eval` |
| `network list\|get <n>\|clear` | `webindex_browser_network` (destructive: `clear` deletes the log) |
| `tabs list\|new\|select\|close` | `webindex_browser_tabs` |
| `back`, `forward`, `reload` | `webindex_browser_history` |
| (MCP only) | `webindex_browser_dialog` |
| `status` | `webindex_browser_status` (`show` required) |
| `close` (`--all`) | `webindex_browser_close` (`forget` required) |
