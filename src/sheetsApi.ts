import type { AppConfig } from "./config";
import { withRetry } from "./retry";

// ── Types ───────────────────────────────────────────────────────────────────

interface WeekAllocation {
  /** Week start date (YYYY-MM-DD) */
  weekStart: string;
  /** SP allocated to this week */
  sp: number;
}

export interface ScheduleRow {
  category: string;
  item: string;
  description: string;
  company: string;
  totalSp: number | null;
  allocations: WeekAllocation[];
  /** First week with SP allocation (YYYY-MM-DD) */
  plannedStart: string | null;
  /** Last week with SP allocation (YYYY-MM-DD) */
  plannedEnd: string | null;
}

export interface ScheduleData {
  rows: ScheduleRow[];
  weekDates: string[];
  raw: string[][];
}

// ── Fetch ───────────────────────────────────────────────────────────────────

async function fetchSheetValues(
  config: AppConfig,
  range?: string
): Promise<string[][]> {
  if (!config.googleSheetsId || !config.googleSheetsApiKey) {
    console.warn("Google Sheets not configured (GOOGLE_SHEETS_ID or GOOGLE_SHEETS_API_KEY missing)");
    return [];
  }

  const sheetRange = range || config.googleSheetsRange || "Sheet1";
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${config.googleSheetsId}/values/${encodeURIComponent(sheetRange)}?key=${config.googleSheetsApiKey}`;

  return withRetry(
    async () => {
      const res = await fetch(url);
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(`Google Sheets API error: ${res.status} ${detail}`);
      }

      const data = (await res.json()) as { values?: string[][] };
      return data.values ?? [];
    },
    { label: "Google Sheets" }
  );
}

// ── Date parsing helpers ────────────────────────────────────────────────────

/**
 * Row 0 の月ヘッダー（"1月", "2月" ...）と Row 1 の日ヘッダー（"7日", "14日" ...）
 * を組み合わせて、データ列ごとの YYYY-MM-DD を算出する。
 *
 * Row 0 例: ['2026/02/19', '', '', '', '', '1月', '', '', '↓デプロイ', '2月', ...]
 * Row 1 例: ['大項目', '小項目', '内容', '実施社', 'SP', '7日', '14日', '21日', '28日', '4日', ...]
 */
function parseWeekDates(
  monthRow: string[],
  dayRow: string[],
  dataStartIdx: number
): string[] {
  // Extract year from first cell (e.g. "2026/02/19")
  const yearMatch = (monthRow[0] ?? "").match(/^(\d{4})/);
  const baseYear = yearMatch ? parseInt(yearMatch[1], 10) : new Date().getFullYear();

  // Build month mapping: carry forward the last seen month
  let currentMonth = 0;
  let prevMonth = 0;
  const dates: string[] = [];

  for (let i = dataStartIdx; i < dayRow.length; i++) {
    // Check if Row 0 has a month label at this index
    const monthCell = (monthRow[i] ?? "").trim();
    const monthMatch = monthCell.match(/^(\d{1,2})月$/);
    if (monthMatch) {
      currentMonth = parseInt(monthMatch[1], 10);
    }

    const dayCell = (dayRow[i] ?? "").trim();
    const dayMatch = dayCell.match(/^(\d{1,2})日$/);
    if (!dayMatch || currentMonth === 0) {
      dates.push("");
      continue;
    }

    const day = parseInt(dayMatch[1], 10);

    // Handle year boundary (e.g. Dec → Jan)
    let year = baseYear;
    if (currentMonth < prevMonth) {
      year = baseYear + 1;
    }
    prevMonth = currentMonth;

    const mm = String(currentMonth).padStart(2, "0");
    const dd = String(day).padStart(2, "0");
    dates.push(`${year}-${mm}-${dd}`);
  }

  return dates;
}

// ── Main fetch & parse ──────────────────────────────────────────────────────

/**
 * ガントチャート形式のスプレッドシートを取得・構造化して返す。
 *
 * 想定構造:
 *   Row 0: [参照日, ..., "1月", ..., "2月", ...]   ← 月ヘッダー
 *   Row 1: ["大項目", "小項目", "内容", "実施社", "SP", "7日", "14日", ...] ← 列ヘッダー
 *   Row 2+: データ行（週列に SP 数値が入る）
 */
export async function fetchScheduleData(
  config: AppConfig,
  range?: string
): Promise<ScheduleData> {
  const raw = await fetchSheetValues(config, range);
  if (raw.length < 3) {
    return { rows: [], weekDates: [], raw };
  }

  const monthRow = raw[0];
  const headerRow = raw[1];

  // Find data column start (first "X日" column in Row 1)
  const dataStartIdx = headerRow.findIndex((h) => /^\d{1,2}日$/.test(h.trim()));
  if (dataStartIdx < 0) {
    console.warn("Google Sheets: no date columns found in header row");
    return { rows: [], weekDates: [], raw };
  }

  const weekDates = parseWeekDates(monthRow, headerRow, dataStartIdx);

  // Map header columns
  const lower = (s: string) => s.toLowerCase().trim();
  const colIdx = (names: string[]): number =>
    headerRow.findIndex((h) => names.some((n) => lower(h) === n));
  const colIdxPartial = (names: string[]): number =>
    headerRow.findIndex((h) => names.some((n) => lower(h).includes(n)));

  const catIdx = colIdx(["大項目"]);
  const itemIdx = colIdx(["小項目"]) >= 0 ? colIdx(["小項目"]) : colIdxPartial(["項目"]);
  const descIdx = colIdxPartial(["内容"]);
  const companyIdx = colIdxPartial(["実施社", "担当"]);
  const spIdx = colIdx(["sp"]) >= 0 ? colIdx(["sp"]) : colIdxPartial(["sp"]);

  const cellAt = (row: string[], idx: number): string =>
    idx >= 0 && idx < row.length ? (row[idx] ?? "").trim() : "";

  const rows: ScheduleRow[] = [];
  let lastCategory = "";

  for (let r = 2; r < raw.length; r++) {
    const row = raw[r];
    const cat = cellAt(row, catIdx);
    const item = cellAt(row, itemIdx);
    if (!cat && !item) continue; // skip empty / legend rows

    if (cat) lastCategory = cat;

    const spStr = cellAt(row, spIdx);
    const totalSp = spStr ? parseFloat(spStr) : null;

    // Parse weekly SP allocations
    const allocations: WeekAllocation[] = [];
    for (let c = 0; c < weekDates.length; c++) {
      const date = weekDates[c];
      if (!date) continue;
      const val = cellAt(row, dataStartIdx + c);
      const num = val ? parseFloat(val) : NaN;
      if (!isNaN(num) && num > 0) {
        allocations.push({ weekStart: date, sp: num });
      }
    }

    const plannedStart = allocations.length > 0 ? allocations[0].weekStart : null;
    const plannedEnd =
      allocations.length > 0
        ? allocations[allocations.length - 1].weekStart
        : null;

    rows.push({
      category: lastCategory,
      item,
      description: cellAt(row, descIdx),
      company: cellAt(row, companyIdx),
      totalSp,
      allocations,
      plannedStart,
      plannedEnd
    });
  }

  return { rows, weekDates, raw };
}

// ── Deviation analysis ──────────────────────────────────────────────────────

export function analyzeScheduleDeviation(
  data: ScheduleData,
  today: string
): {
  onTrack: ScheduleRow[];
  delayed: ScheduleRow[];
  atRisk: ScheduleRow[];
  notStarted: ScheduleRow[];
  summary: string;
} {
  const onTrack: ScheduleRow[] = [];
  const delayed: ScheduleRow[] = [];
  const atRisk: ScheduleRow[] = [];
  const notStarted: ScheduleRow[] = [];

  for (const row of data.rows) {
    if (!row.plannedEnd) {
      notStarted.push(row);
      continue;
    }

    // 予定終了週を過ぎている → 遅延
    const endPlus7 = addDays(row.plannedEnd, 7); // week end
    if (endPlus7 < today) {
      delayed.push(row);
    } else if (row.plannedEnd <= today) {
      // 今週が最終週 → リスク
      atRisk.push(row);
    } else {
      onTrack.push(row);
    }
  }

  const total = data.rows.length;
  const totalSp = data.rows.reduce((sum, r) => sum + (r.totalSp ?? 0), 0);

  // 今週の予定 SP
  const currentWeek = data.weekDates.filter((d) => d && d <= today).pop() ?? "";
  const thisWeekSp = currentWeek
    ? data.rows.reduce((sum, r) => {
        const alloc = r.allocations.find((a) => a.weekStart === currentWeek);
        return sum + (alloc?.sp ?? 0);
      }, 0)
    : 0;

  const summary = [
    `スケジュール状況: 全${total}件 (合計 ${totalSp} SP)`,
    `  順調: ${onTrack.length}件`,
    `  遅延（予定終了週超過）: ${delayed.length}件`,
    `  リスク（今週が最終週）: ${atRisk.length}件`,
    `  未着手（SP配分なし）: ${notStarted.length}件`,
    `  今週の予定SP: ${thisWeekSp}`
  ].join("\n");

  return { onTrack, delayed, atRisk, notStarted, summary };
}

export function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
