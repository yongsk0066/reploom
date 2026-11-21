# Interface

On wide embeds, the workspace opens with code and preview side by side. Each pane has a 360px content area. The upper toolbar switches panels, expands the workspace, and opens display settings.

## Layout and controls

Both panes stay mounted when a reader switches views. Below 560px of component width, `mobileView` selects the first panel (code by default). Readers can still select Both to stack the panes. An explicit `defaultView` takes precedence at every width. Compact panes use `clamp(240px, 45svh, 320px)`. Expanding sets either layout to 600px.

File tabs support Left/Right, Home and End. Tab from the selected file reaches the editor. The file bar also lets readers copy the current file and activate a deferred editor. Run again restarts the preview with the current code. Reset source asks for confirmation before restoring the original project. Following a current diagnostic selects and focuses its source line. A split view keeps the preview visible, and a preview-only view opens the editor.

Display settings control line numbers (while editing, always or off), wrapping (automatic at narrow widths, on or off), code text size and theme. Choices are shared between embeds on the same origin and saved in local storage when available. They reconfigure the existing editor while preserving its undo history, selection and preview state. `highlightLines={[first, last]}` marks an inclusive range in the opening file while its original source is displayed.

A gallery can expose the Files dialog for adding, moving and deleting files. Deleting a file requires confirmation, and required files are protected. Tests and type checks have separate actions when the prepared project supports them. `showTools={false}` gives an article the reading and editing controls alone.

## Style ownership

The React view creates one open shadow root per mounted instance and renders through a React portal. Controls, labels, descriptions, and their ID references stay in that root. The host itself is not a focus stop; Tab reaches the actual controls. Focus is not delegated to a default child because this is a composite workspace with several independent controls. The session's focus priority reads the shadow root's active element.

A constructed stylesheet is cached by document and shared across instances. Browser-specific editor styles remain owned by CodeMirror. The view imports no external fonts and inherits the host's font family. Its shadow host establishes the relative base text size, which internal controls inherit; this also propagates user font-size changes through fixed-font parent containers. Preview styles belong to the sandboxed iframe and remain separate from both the page and the editor UI.

Set these CSS custom properties on a surrounding element; the color examples below use the dark palette. Public properties remain inherited rather than being redeclared on the shadow host.

| Property | Default | Purpose |
| --- | --- | --- |
| `--reploom-background` | `#18181b` | Main chrome |
| `--reploom-surface` | `#202024` | Pane toolbars |
| `--reploom-hover` | `#303036` | Hover and selected controls |
| `--reploom-text` | `#e4e4e7` | Primary text |
| `--reploom-muted` | `#b4b4bd` | Secondary text |
| `--reploom-border` | `#3f3f46` | Dividers |
| `--reploom-focus` | `#a5b4fc` | Keyboard focus |
| `--reploom-radius` | `8px` | Outer surface and dialog corners |
| `--reploom-control-radius` | `4px` | Control corners |
| `--reploom-margin` | `24px` | Outer block spacing |
| `--reploom-font-size` | `0.8125rem` | Controls |
| `--reploom-code-size` | `0.8125rem` | Source text |
| `--reploom-pane-height` | `360px` | Initial code and preview height |
| `--reploom-mobile-height` | compact viewport height | Narrow pane height |
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
