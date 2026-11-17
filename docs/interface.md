# Interface

Reploom embeds a small editing workspace in a page. Reading the example, changing a file, and checking the result are the primary flow. The default view keeps code and preview together, with file navigation above the editor and a restart action above the result.

## Layout and controls

The file strip supports pointer selection, horizontal scrolling, Left/Right, Home, and End. Only the selected tab enters the Tab sequence; Tab then reaches the editor. The editor maintains each file's selection, scroll position, and undo history.

Code, Preview, and Both change the visible panes. They do not replace the editor, create another session, or reload the iframe. Expand changes their height. At less than 560px of available component width, Both becomes a vertical stack. This threshold is a container query, so an example in a narrow article responds correctly even on a wide monitor.

Run again restarts the current program without discarding source edits. Reset source restores the initial files and preview state after a native confirmation dialog. Cancel is the initially focused action; Escape dismisses the dialog. Error locations select and focus the affected source, opening the code pane when necessary. Logs, live-edit guidance, and project tools use native disclosure elements.

`showTitle`, `showTools`, and `defaultView` configure the same view. Hiding project tools removes file-management and archive controls from the presentation; the underlying session API remains available to custom interfaces. A blog embed can hide the title and tools, while a standalone gallery can expose them.

## Style ownership

The React view creates one open shadow root per mounted instance and renders through a React portal. Controls, labels, descriptions, and their ID references stay in that root. The host itself is not a focus stop; Tab reaches the actual controls. Focus is not delegated to a default child because this is a composite workspace with several independent controls. The session's focus priority reads the shadow root's active element.

A constructed stylesheet is cached by document and shared across instances. Browser-specific editor styles remain owned by CodeMirror. The view imports no external fonts and inherits the host's font family. Its shadow host establishes the relative base text size, which internal controls inherit; this also propagates user font-size changes through fixed-font parent containers. Preview styles belong to the sandboxed iframe and remain separate from both the page and the editor UI.

Set these CSS custom properties on a surrounding element; defaults are shown below. Public properties remain inherited rather than being redeclared on the shadow host.

| Property | Default | Purpose |
| --- | --- | --- |
| `--reploom-background` | `#18181b` | Main chrome |
| `--reploom-surface` | `#202024` | Pane toolbars |
| `--reploom-hover` | `#303036` | Hover and selected controls |
| `--reploom-text` | `#e4e4e7` | Primary text |
| `--reploom-muted` | `#a1a1aa` | Secondary text |
| `--reploom-border` | `#3f3f46` | Dividers |
| `--reploom-focus` | `#a5b4fc` | Keyboard focus |
| `--reploom-radius` | `8px` | Outer surface and dialog corners |
| `--reploom-control-radius` | `4px` | Control corners |
| `--reploom-margin` | `24px` | Outer block spacing |
| `--reploom-font-size` | `0.8125rem` | Controls |
| `--reploom-code-size` | `0.8125rem` | Source text |
| `--reploom-pane-height` | `300px` | Initial code and preview height |
| `--reploom-expanded-height` | `600px` | Expanded height |

The `surface`, `editor`, and `preview` parts allow targeted host styling through `.reploom-host::part(...)`. Internal class selectors are implementation details. Changes that alter layout should preserve overflow, focus visibility, and the preview's usable viewport.

The base toolbar is 40px high with 32px controls, 4px gaps, and 8–12px insets. Coarse-pointer controls grow to 44px. Text uses relative units so user font preferences remain effective. The component reserves its editor and preview heights rather than sizing them from user program output.

## Scrolling

The CodeMirror adapter locks diagonal wheel input to the dominant axis selected at the start of a gesture. A 160ms pause starts a new gesture. Single-axis input, Shift-wheel, and zoom retain native handling. At a boundary, diagonal input continues along the selected axis into the nearest scrollable ancestor, including across the shadow boundary, so a long article remains reachable.

The wheel listener belongs to the editor and is removed on destruction. It intercepts only cross-axis drift, with no React state update or compiler message. Native touch panning and scrollbar dragging are unchanged. `editorOptions={{ scrollAxisLock: false }}` disables this behavior.

## Design references and boundaries

[Sandpack's layout API](https://sandpack.codesandbox.io/docs/getting-started/layout) informed the aligned code/preview regions, file tabs, and stable pane heights. [React's documentation UI](https://github.com/reactjs/react.dev/tree/main/src/components/MDX/Sandpack) provides a useful reference for expanding a bounded example and separating restart from source reset.

[CodePen embeds](https://blog.codepen.io/docs/embeds/) and [JSFiddle embeds](https://docs.jsfiddle.net/embedding-fiddles) demonstrate choosing code, result, or both according to the surrounding explanation. [StackBlitz's embed options](https://developer.stackblitz.com/platform/api/javascript-sdk-options) distinguish the useful parts of a full workspace from optional navigation and developer tools. Reploom keeps project-management controls optional; terminal, remote sharing, and URL navigation are separate product capabilities rather than decorative controls.

The visual review used [unslop by Damir Sokolovsky](https://github.com/heydamir/unslop) (CC BY 4.0) to check grouping, density, neutral chrome, and consistency with the host's identity. Implementation guidance came from [Modern Web Guidance](https://developer.chrome.com/docs/modern-web-guidance): shared shadow stylesheets, inherited theme properties, container queries, native dialogs, and same-tree accessibility relationships.

Browser tests cover style isolation, shared sheets, keyboard navigation, reset/cancel, hidden-editor error recovery, view-state retention, and diagonal wheel input in Chromium, Firefox, and WebKit. These are functional checks; they do not replace assistive-technology or physical-device usability testing.
