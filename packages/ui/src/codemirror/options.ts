export type LanguageAnalysisOptions = {
  minCharacters?: number;
  idleMs?: number;
  createWorker?(signal: AbortSignal): Worker | Promise<Worker>;
  onError?(error: unknown): void;
};

export type EditorOptions = {
  language?: LanguageAnalysisOptions | false;
  scrollAxisLock?: boolean;
};

export type EditorDisplay = {
  numbers: boolean;
  wrap: boolean;
  themed: boolean;
  diagnostics?: readonly { line?: number; text: string }[];
  emphasis?: readonly [number, number];
};
