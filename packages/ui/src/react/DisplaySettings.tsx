import { useLayoutEffect, useRef, useState, type Ref } from "react";
import { defaults, type DisplayPreferences } from "./preferences.ts";
import type { PlaygroundLabels } from "./labels.ts";

const shapes = {
  settings: (
    <>
      <path d="M4 7h8m4 0h4M4 17h3m4 0h9" />
      <circle cx="14" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
    </>
  ),
  expand: <path d="M4 9V4h5m6 16h5v-5M4 4l6 6m10 10-6-6" />,
  collapse: <path d="M10 4v6H4m10 10v-6h6M4 4l6 6m10 10-6-6" />,
  copy: (
    <>
      <rect x="8" y="8" width="12" height="13" rx="2" />
      <path d="M15 8V3H3v13h5" />
    </>
  ),
  edit: <path d="m4 16-1 5 5-1L20 8l-4-4zM13.5 6.5l4 4" />,
};

export function ControlIcon({ name }: { name: keyof typeof shapes }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="reploom-icon">
      {shapes[name]}
    </svg>
  );
}

type SettingsProps = {
  id: string;
  labels: PlaygroundLabels;
  value: DisplayPreferences;
  onChange(value: DisplayPreferences): void;
};

export function SettingsButton({
  label,
  onClick,
  ref,
}: {
  label: string;
  onClick?(): void;
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      type="button"
      className="reploom-icon-button"
      aria-label={label}
      ref={ref}
      title={label}
      aria-haspopup="dialog"
      onClick={onClick}
    >
      <ControlIcon name="settings" />
    </button>
  );
}

export function DisplaySettings(props: SettingsProps) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);

  function close() {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  }

  return (
    <>
      <SettingsButton ref={trigger} label={props.labels.settings} onClick={() => setOpen(true)} />
      {open && <SettingsDialog {...props} close={close} />}
    </>
  );
}

function SettingsDialog({ close, id, labels, value, onChange }: SettingsProps & { close(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    dialog.current?.showModal();
  }, []);

  const fields = [
    [
      "numbers",
      labels.lineNumbers,
      [
        ["editing", labels.whenEditing],
        ["always", labels.always],
        ["off", labels.off],
      ],
    ],
    [
      "wrap",
      labels.lineWrap,
      [
        ["auto", labels.fit],
        ["on", labels.on],
        ["off", labels.off],
      ],
    ],
    [
      "fontSize",
      labels.fontSize,
      [
        ["base", labels.siteDefault],
        ["large", labels.large],
        ["larger", labels.larger],
      ],
    ],
    [
      "theme",
      labels.theme,
      [
        ["site", labels.siteDefault],
        ["light", labels.light],
        ["dark", labels.dark],
      ],
    ],
  ] as const;

  return (
    <dialog
      onClose={close}
      ref={dialog}
      className="reploom-reset-dialog reploom-settings"
      aria-labelledby={id + "-settings"}
    >
      <h2 className="reploom-dialog-title" id={id + "-settings"}>
        {labels.settings}
      </h2>
      {fields.map(([key, label, options]) => (
        <label key={key}>
          {label}
          <select
            value={value[key]}
            onChange={(event) => onChange({ ...value, [key]: event.currentTarget.value })}
          >
            {options.map(([v, text]) => (
              <option key={v} value={v}>
                {text}
              </option>
            ))}
          </select>
        </label>
      ))}
      <form method="dialog">
        <button type="button" onClick={() => onChange(defaults)}>
          {labels.resetDisplay}
        </button>
        <button>{labels.close}</button>
      </form>
    </dialog>
  );
}
