"use client";

// 「撮る」タブやホームのボタンで選んだ画像を /scan ページへ受け渡すための一時置き場。
// （タップ＝ユーザー操作の瞬間にカメラ/フォルダを開き、選択後に /scan で即解析するため）
// fromLibrary: アルバム/スクショ選択なら true（保存後に「元画像の削除リマインド」を出す）
export interface PendingImage {
  file: File;
  fromLibrary: boolean;
}

let pending: PendingImage | null = null;

export function setPendingImage(file: File, fromLibrary = false) {
  pending = { file, fromLibrary };
}

export function takePendingImage(): PendingImage | null {
  const p = pending;
  pending = null;
  return p;
}
