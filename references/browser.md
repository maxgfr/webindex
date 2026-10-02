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
   `press Escape`. Add `--snapshot` to get the new tree in the same call.
4. Check the result with `wait --text "Results"`, `wait --url /done` or `wait --idle`,
   then take a new snapshot before the next act.

`snapshot --interactive` lists only the controls and is much shorter.
`snapshot e40` shows one subtree. Same-origin iframes are expanded.

## Refs

- **`eN` is the element's `backendDOMNodeId`**, kept in `refs/<tab>.json`. A
  ref stays the same within one document: a later snapshot hands the same
  element the same `eN`.
- **A ref goes stale when the tab loads another document.** An action on it then
  fails with exit 1: `ref "e12" is unknown or stale: take a new snapshot`. Take
  one and use its refs. Never guess a ref.
- **A click is a real mouse press** at the element's centre, refused when
  something covers that point (a cookie banner); the error names it.

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
  `open` reports `challenge: cloudflare (blocking)`, tell the user, then run
  `wait --clear`, which waits up to 5 minutes for the wall to go. After a login,
  run `wait --url <pattern>`. Do not log in for the user.
- **No anti-bot bypass of any kind**: no stealth patches, no captcha solvers,
  no fingerprint spoofing. A challenge is named and left to the human.
- **`eval` runs in the logged-in page.** Read with it. Never use it to do what
  the guard would refuse, such as `el.click()` on a pay button.
- **MCP uploads** stay under `--extract-root`; with none, they need
  `confirm: true` after the user approves the exact files.

## Profiles and the launch policy

The profile lives in `~/.webindex/browser/profiles/<name>` (`--profile <n>`,
`default` otherwise). The browser home is `WEBINDEX_BROWSER_DIR`. Its
directories are 0700 and its files 0600: it holds logins. A login made there
lasts across runs. `profile import <chrome|brave|chromium|edge|path>` copies an
existing browser's session in once. It refuses a source that is running and a
target that exists unless `--force`. Cookies are encrypted per browser kind, so
import from the same browser you run: a Brave profile under Chrome reads as
logged out. `profile reset` deletes a profile, `profile path` prints it.

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
   nowhere for a human to solve a challenge.

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

## Network capture

`open <url> --capture` (or `--capture` on any action) records the JSON
responses the page fetches (XHR and fetch) while that command runs.
`network list` numbers them, `network get <n>` prints one body as JSON, and
`network clear` empties the log. Headers are never stored. URLs keep their
query strings, and request bodies (`postData`, up to 4 KiB) are stored raw, so a
recorded login POST can hold the password. Clear the log after a session where
that matters.

## Accepted limits

- **Cross-origin iframes** (out-of-process) are not expanded in the snapshot.
- **In the CLI, capture and dialogs last only one command.** The browser hands
  a dialog only to the connection that saw it open. So a dialog a page opens
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
| `WEBINDEX_BROWSER_FETCH` | `always`, `fallback` or `off` (default): whether `fetch` renders pages in the browser |
| `WEBINDEX_BROWSER_CONCURRENCY` | pages the fetch rung renders at once (default 1, at most 4) |
| `WEBINDEX_BROWSER_TIMEOUT_MS` | how long the fetch rung gives one page (default 30000) |

## Over MCP

`webindex mcp --browser` adds 19 tools over one session that lives as long as
the server, so captures and dialogs persist across calls: a dialog stays open,
and the page tools are refused, until `webindex_browser_dialog` answers it.
They are refused with `--allow-remote` or `--public-only`: a logged-in browser
here is for this machine alone. Waits are capped at 300 s and stop on cancel.
Tools that change the page return the snapshot taken after them.

| CLI | MCP tool |
|---|---|
| `open <url>` (`--new-tab`, `--capture`, `--profile`, `--headless`) | `webindex_browser_open` |
| `snapshot [<ref>]` (`--interactive`) | `webindex_browser_snapshot` (`mode` required) |
| `click`, `hover`, `type`, `fill`, `select`, `press`, `upload`, `scroll` | `webindex_browser_<same name>` |
| `wait --text\|--gone\|--selector\|--url\|--load\|--idle\|--clear\|--ms` | `webindex_browser_wait` (`condition`, `value`) |
| `screenshot [<ref>]` (`--full`) | `webindex_browser_screenshot` (`area` required; JPEG, 4 MB at most) |
| `eval <expr>` | `webindex_browser_eval` |
| `network list\|get <n>\|clear` | `webindex_browser_network` (destructive: `clear` deletes the log) |
| `tabs list\|new\|select\|close` | `webindex_browser_tabs` |
| `back`, `forward`, `reload` | `webindex_browser_history` |
| (MCP only) | `webindex_browser_dialog` |
| `status` | `webindex_browser_status` (`show` required) |
| `close` (`--all`) | `webindex_browser_close` (`forget` required) |
