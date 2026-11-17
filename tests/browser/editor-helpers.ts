import { expect, type Locator } from "@playwright/test";

// Exercise CodeMirror's public keyboard/clipboard behavior instead of relying on
// its virtualized DOM text or private view fields. No system clipboard access.
export async function readCode(editor: Locator) {
  await expect(editor).toHaveAttribute("contenteditable", "true");
  await editor.press("ControlOrMeta+a");
  return editor.evaluate((element) => {
    // Firefox does not reuse the DataTransfer passed to ClipboardEvent's
    // constructor. Read the event's transfer, which the editor actually fills.
    const event = new ClipboardEvent("copy", {
      clipboardData: new DataTransfer(),
      bubbles: true,
      cancelable: true,
    });

    element.dispatchEvent(event);
    return event.clipboardData?.getData("text/plain") || "";
  });
}

export async function writeCode(editor: Locator, text: string) {
  // Use the public clipboard path: DOM-only fill / synthetic multiline text
  // insertion can bypass the editor's document model (especially in Firefox).
  await editor.press("ControlOrMeta+a");
  await editor.evaluate((element, value) => {
    const event = new ClipboardEvent("paste", {
      clipboardData: new DataTransfer(),
      bubbles: true,
      cancelable: true,
    });

    event.clipboardData!.setData("text/plain", value);
    element.dispatchEvent(event);
  }, text);
}
