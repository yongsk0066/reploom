import { useEffect, useMemo, useState } from "react";
import { defaultLabels, type PlaygroundLabels } from "./labels.ts";

const packs = { ko: () => import("../locales/ko.ts"), ja: () => import("../locales/ja.ts") };

export function useLabels(locale?: string, overrides?: Partial<PlaygroundLabels>) {
  const language = locale?.toLowerCase().split("-")[0];
  const loader = language === "ko" || language === "ja" ? packs[language] : undefined;

  const complete = useMemo(
    () => overrides && Object.keys(defaultLabels).every((key) => Object.hasOwn(overrides, key)),
    [overrides],
  );

  const [pack, setPack] = useState<{ language?: string; labels: PlaygroundLabels }>();
  useEffect(() => {
    if (!loader || complete) return;
    let active = true;
    void loader()
      .then(({ labels }) => {
        if (active) setPack({ language, labels });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [loader, language, complete]);
  return useMemo(
    () => ({
      ...defaultLabels,
      ...(pack && pack.language === language ? pack.labels : undefined),
      ...overrides,
    }),
    [pack, language, overrides],
  );
}
