import { defaultLabels, type PlaygroundLabels } from "../react/labels.ts";

export const labels: PlaygroundLabels = {
  ...defaultLabels,
  close: "閉じる",
  tools: "プロジェクトツール",
  files: "ファイル",
  path: "保存先のパス",
  addFile: "ファイルを追加",
  moveFile: "選択したファイルを移動",
  removeFile: "選択したファイルを削除",
  projectSnapshot: "保存と復元",
  includeState: "保存可能なプレビューの状態を含める",
  saveProject: "プロジェクトを保存",
  restoreSaved: "保存したプロジェクトを復元",
  openProject: "プロジェクトファイルを開く",
  runTests: "独立したテストを実行",
  checkTypes: "型チェック",
  loading: "サンプルを読み込み中…",
  rerun: "再実行",
  reset: "コードをリセット",
  resetDescription: "元のコードに戻して再実行しますか？編集内容と現在の実行状態は失われます。",
  confirmReset: "元のコードに戻す",
  cancel: "キャンセル",
  rerunHint: "現在のコードで再実行します。プレビューの状態はリセットされます。",
  view: "表示方法",
  code: "コード",
  split: "両方",
  expand: "広げる",
  collapse: "縮める",
  help: "編集について",
  file: "ファイル",
  preview: "プレビュー",
  edit: "コードを編集",
  editorFallback: "コードエディターを読み込めないため、テキストエディターを使用します。",
  source: (path) => `${path} のコード`,
  console: (count) => `コンソール (${count})`,
  hint: (runtime) =>
    runtime === "compute"
      ? "別のWorkerで実行します。停止やタイムアウトで状態がリセットされます。"
      : runtime === "dom"
        ? "編集時は明示的な状態オブジェクトを維持し、再実行でリセットします。"
        : "互換性のある編集では状態を維持します。Hookの構造変更でリセットされる場合があります。",
  status(state) {
    switch (state.phase) {
      case "loading":
        return "サンプルを読み込み中…";
      case "starting":
        return "変更を適用中…";
      case "compiling":
        return "変更をコンパイル中…";
      case "disposed":
        return "サンプルを終了しました。";
      case "editing":
        return state.reason === "composition" ? "文字の確定を待機中…" : "編集を待機中…";
      case "error":
        return state.requiresRestart
          ? "編集するとプレビューを再起動します。"
          : state.stage === "load"
            ? "サンプルを読み込めませんでした。"
            : state.stage === "compile"
              ? "コンパイルエラーがあります。前のプレビューを維持しています。"
              : "実行時エラーが発生しました。";
      case "ready":
        return {
          initial: "実行中",
          styles: "スタイル更新・状態維持",
          refreshed: "変更を適用しました",
          remounted: "再マウントしました。一部の状態がリセットされた可能性があります。",
          recovered: "エラーから復旧しました",
          computed: "計算完了",
          cancelled: "計算停止",
        }[state.outcome];
    }
  },
  settings: "表示設定",
  lineNumbers: "行番号",
  lineWrap: "長い行の折り返し",
  fontSize: "コードの文字サイズ",
  theme: "配色",
  whenEditing: "編集中のみ",
  always: "常に表示",
  off: "オフ",
  on: "オン",
  fit: "幅に合わせる",
  siteDefault: "サイトの既定値",
  large: "大",
  larger: "特大",
  light: "ライト",
  dark: "ダーク",
  resetDisplay: "表示設定をリセット",
  copySource: "ファイルをコピー",
  copied: "コピーしました",
  copyFailed: "コードを選択してコピーしてください。",
  lastWorking: "直前の実行結果を表示中",
  clearConsole: "コンソールを消去",
  checks: "チェック",
  runningCheck: "チェック中…",
  passedCheck: "成功",
  failedCheck: "失敗",
  fileRejected:
    "対応するファイル名を入力してください。1つのプロジェクトに追加できるファイルは32個までです。",
  fileExists: "同名のファイルがあります。",
  archiveTooLarge: "5 MiB 以下のプロジェクトファイルを選択してください。",
  compute: {
    output: "計算結果",
    stop: "計算を停止",
    stopped: "計算が停止しました。コードを編集するか再実行してください。",
    complete: "計算完了",
    failed: "計算に失敗しました。コードを編集すると再実行します。",
    cancelled: "計算を停止し実行状態をリセットしました。",
    computing: "計算中",
  },
  removeNamed: (path) => path + " を削除",
  omitted: (count) => count + " 件のメッセージを省略しました",
  share: "サンプルを共有",
  shareLink: "プロジェクトリンク",
  copyLink: "リンクをコピー",
  openLink: "共有サンプルを開く",
  linkCopied: "リンクをコピーしました。",
  copyManually: "リンクを選択してコピーしてください。",
  shareFailed: "リンクを作成できませんでした。",
  shareTooLarge: "リンクに含めるには大きすぎます。ファイルとして保存してください。",
};
