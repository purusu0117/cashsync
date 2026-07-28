// レシート内分割：1枚のレシート（合計）を複数カテゴリに按分するための純粋ロジック。
// 確認シートで「品目ごとにカテゴリを分ける」を選んだとき、各行（品目やカテゴリ割当）を
// カテゴリ単位でまとめた複数の支出行に変換する。receipts API と test-suite の両方から使う
// （サーバー依存なしの純関数なので単体テストしやすい）。

export interface SplitAssignment {
  categoryId: string | null;
  amount: number;
}

export interface SplitExpenseLine {
  categoryId: string | null;
  amount: number;
}

/**
 * 分割入力を「保存する支出行」の配列に正規化する。
 *  - amount は四捨五入し、0以下・非数の行は捨てる
 *  - 同一カテゴリ（null含む）は合算して1行にまとめる（カテゴリ単位で1支出）
 *  - 割当合計がレシート合計に満たない未割当分は categoryId=null（その他）に寄せて合計を一致させる
 *  - 割当合計がレシート合計を超える場合は、ユーザーが明示した金額を勝手に削らずそのまま返す
 * 返り値は「最初に現れたカテゴリ順」で安定させる（未割当補填のnull行だけ末尾に付く場合がある）。
 */
export function buildReceiptSplits(
  receiptTotal: number,
  assignments: SplitAssignment[],
): SplitExpenseLine[] {
  const order: (string | null)[] = [];
  const byCat = new Map<string | null, number>();
  for (const a of assignments) {
    const amount = Math.round(Number(a?.amount));
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const key = a.categoryId ?? null;
    if (!byCat.has(key)) order.push(key);
    byCat.set(key, (byCat.get(key) ?? 0) + amount);
  }
  const total = Math.round(Number(receiptTotal));
  const assigned = [...byCat.values()].reduce((s, n) => s + n, 0);
  const remainder = Number.isFinite(total) ? total - assigned : 0;
  if (remainder > 0) {
    if (!byCat.has(null)) order.push(null);
    byCat.set(null, (byCat.get(null) ?? 0) + remainder);
  }
  return order.map((key) => ({ categoryId: key, amount: byCat.get(key)! }));
}
