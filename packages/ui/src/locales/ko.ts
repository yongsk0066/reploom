import { defaultLabels, type PlaygroundLabels } from "../react/labels.ts";

export const labels: PlaygroundLabels = {
  ...defaultLabels,
  close: "닫기",
  tools: "프로젝트 도구",
  files: "파일",
  path: "새 파일 경로",
  addFile: "파일 추가",
  moveFile: "선택한 파일 이동",
  removeFile: "선택한 파일 삭제",
  projectSnapshot: "저장 및 복원",
  includeState: "저장 가능한 미리보기 상태 포함",
  saveProject: "프로젝트 저장",
  restoreSaved: "저장한 프로젝트 복원",
  openProject: "프로젝트 파일 열기",
  runTests: "격리된 테스트 실행",
  checkTypes: "타입 검사",
  loading: "예제를 불러오는 중…",
  rerun: "다시 실행",
  reset: "코드 초기화",
  resetDescription:
    "원래 코드로 되돌리고 미리보기를 다시 시작할까요? 수정한 코드와 현재 실행 상태가 사라집니다.",
  confirmReset: "원래 코드로 복원",
  cancel: "취소",
  rerunHint: "현재 코드로 다시 실행합니다. 미리보기의 상태는 초기화됩니다.",
  view: "보기 방식",
  code: "코드",
  split: "함께 보기",
  expand: "펼치기",
  collapse: "접기",
  help: "편집 안내",
  file: "파일",
  preview: "미리보기",
  edit: "코드 편집",
  editorFallback: "코드 편집기를 불러오지 못해 기본 텍스트 편집기를 사용합니다.",
  source: (path) => `${path} 코드`,
  console: (count) => `콘솔 (${count})`,
  hint: (runtime) =>
    runtime === "compute"
      ? "별도 Worker에서 실행합니다. 중지하거나 시간이 초과되면 상태가 초기화됩니다."
      : runtime === "dom"
        ? "편집 시 명시적인 상태 객체를 유지합니다. 다시 실행하면 초기화됩니다."
        : "호환되는 편집은 상태를 유지합니다. Hook 구조를 바꾸면 상태가 초기화될 수 있습니다.",
  status(state) {
    switch (state.phase) {
      case "loading":
        return "예제를 불러오는 중…";
      case "starting":
        return "변경 내용을 적용하는 중…";
      case "compiling":
        return "변경 내용을 컴파일하는 중…";
      case "disposed":
        return "예제를 종료했습니다.";
      case "editing":
        return state.reason === "composition"
          ? "글자 조합을 기다리는 중…"
          : "편집 내용을 기다리는 중…";
      case "error":
        return state.requiresRestart
          ? "다시 편집하면 미리보기가 재시작됩니다."
          : state.stage === "load"
            ? "예제를 불러오지 못했습니다."
            : state.stage === "compile"
              ? "컴파일 오류가 있습니다. 마지막 미리보기를 유지합니다."
              : "실행 중 오류가 발생했습니다.";
      case "ready":
        return {
          initial: "실행 중",
          styles: "스타일 적용 · 상태 유지",
          refreshed: "변경 내용 적용 완료",
          remounted: "컴포넌트를 다시 마운트했습니다. 일부 상태가 초기화될 수 있습니다.",
          recovered: "오류 복구 완료",
          computed: "계산 완료",
          cancelled: "계산 중지",
        }[state.outcome];
    }
  },
  settings: "표시 설정",
  lineNumbers: "줄 번호",
  lineWrap: "긴 줄 자동 줄바꿈",
  fontSize: "코드 글자 크기",
  theme: "색상 테마",
  whenEditing: "편집할 때만",
  always: "항상 표시",
  off: "끄기",
  on: "켜기",
  fit: "화면에 맞춤",
  siteDefault: "사이트 기본",
  large: "크게",
  larger: "더 크게",
  light: "라이트",
  dark: "다크",
  resetDisplay: "표시 설정 초기화",
  copySource: "파일 복사",
  copied: "파일을 복사했습니다",
  copyFailed: "코드를 선택해 복사하세요.",
  lastWorking: "마지막 실행 결과 표시 중",
  clearConsole: "콘솔 지우기",
  checks: "검사",
  runningCheck: "검사 중…",
  passedCheck: "통과",
  failedCheck: "실패",
  fileRejected:
    "지원하는 확장자의 파일 이름을 입력하세요. 프로젝트당 최대 32개까지 추가할 수 있습니다.",
  fileExists: "같은 이름의 파일이 있습니다.",
  archiveTooLarge: "5 MiB 이하의 프로젝트 파일을 선택하세요.",
  compute: {
    output: "계산 결과",
    stop: "계산 중지",
    stopped: "계산을 중지했습니다. 코드를 수정하거나 다시 실행하세요.",
    complete: "계산 완료",
    failed: "계산에 실패했습니다. 코드를 수정하면 다시 실행합니다.",
    cancelled: "계산을 중지하고 실행 상태를 초기화했습니다.",
    computing: "계산 중",
  },
  removeNamed: (path) => path + " 삭제",
  omitted: (count) => "생략한 메시지 " + count + "개",
  share: "예제 공유",
  shareLink: "프로젝트 링크",
  copyLink: "링크 복사",
  openLink: "공유 예제 열기",
  linkCopied: "링크를 복사했습니다.",
  copyManually: "링크를 선택해 복사하세요.",
  shareFailed: "링크를 만들지 못했습니다.",
  shareTooLarge: "링크로 만들기에는 예제가 큽니다. 파일로 저장하세요.",
};
