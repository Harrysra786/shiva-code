# dsh-browser

Agent control for the **better-sidebar browser tab**: open it, navigate to a
URL, screenshot the app window showing it, and open external URLs in the system
browser.

The browser tab is a dsh-better-sidebar builtin — a sandboxed, cross-origin
iframe. That boundary is deliberate: a visited page cannot reach the GUI's
origin, storage or `/sidebar/api`. The consequence for automation is that the
agent **cannot** read a visited page's DOM or console, or click inside it. For
the workspace's own prototype — served same-origin by `dsh-prototype` — use the
`prototype_automation` tool instead, which has full `click`/`fill`/`read`/`eval`/
`wait_for`/`console` control.

## Agent tool `browser`

| `op` | Args | Effect |
| --- | --- | --- |
| `open` | `url?` | Open the Browser tab (at `url` when given) |
| `navigate` | `url` | Open the Browser tab at `url` |
| `focus` | — | Bring an open Browser tab to the front |
| `screenshot` | — | Capture the app window showing the tab; saved under `<workspace>/.browser-shots/` and returned as a path |
| `open_external` | `url` | Open `url` in the machine's default browser (OAuth / dashboard links) |

## How it works

- The host half relays one command at a time over `/browser/api/{pending,result}`.
- The client half polls `pending`, opens or focuses the tab through the
  better-sidebar service (`openTab({ type: 'browser', url })`), and answers
  `result`.
- Screenshots use the desktop window-capture bridge
  (`window.dshDesktopScreenCapture`), so they need no gesture and no picker.
