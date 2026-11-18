import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import css from "../styles.css";
import palette from "../reader/palette.css";

const sheets = new WeakMap<Document, CSSStyleSheet>();

function attachSurface(host: HTMLElement) {
  const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  const document = host.ownerDocument;
  let sheet = sheets.get(document);
  if (!sheet) {
    sheet = new document.defaultView!.CSSStyleSheet();
    sheet.replaceSync(css + palette);
    sheets.set(document, sheet);
  }
  if (!root.adoptedStyleSheets.includes(sheet))
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
  return root;
}

export function ShadowSurface({
  children,
  fallback,
}: {
  children: ReactNode;
  fallback: ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [root, setRoot] = useState<ShadowRoot>();

  useEffect(() => {
    setRoot(attachSurface(host.current!));
  }, []);

  return (
    <div ref={host} className="reploom-host">
      {root ? createPortal(children, root) : fallback}
    </div>
  );
}
