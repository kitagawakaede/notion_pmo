import type { AppConfig } from "./config";
import type { SprintTasksSummary, MentionContext } from "./schema";
import type { ReferenceItem } from "./notionApi";
import { toJstDateString, type MentionMessage } from "./workflow";
import {
  type Member,
  type TaskAnalysis,
  type AssigneeMessages,
  type AllocationProposal,
  type NotionUpdateActions,
  type MentionIntent,
  type TaskScheduleMapping,
  taskAnalysisSchema,
  assigneeMessagesSchema,
  allocationProposalSchema,
  notionUpdateActionsSchema,
  mentionIntentSchema,
  taskScheduleMappingSchema,
  replyEvaluationSchema,
  taskAnalysisJsonSchema,
  assigneeMessagesJsonSchema,
  allocationProposalJsonSchema,
  notionUpdateActionsJsonSchema,
  mentionIntentJsonSchema,
  taskScheduleMappingJsonSchema,
  replyEvaluationJsonSchema
} from "./schema";
import type { StoredReply, ActiveThread } from "./workflow";
import { addDays, type ScheduleData, type ScheduleRow } from "./sheetsApi";

// ── Schedule data helpers for LLM context ───────────────────────────────────

function scheduleContextForLlm(
  scheduleData: ScheduleData | null,
  today: string
): object | null {
  if (!scheduleData || scheduleData.rows.length === 0) return null;

  // Group by category
  const byCategory = new Map<string, ScheduleRow[]>();
  for (const row of scheduleData.rows) {
    const cat = row.category || "その他";
    const list = byCategory.get(cat) ?? [];
    list.push(row);
    byCategory.set(cat, list);
  }

  const categories = Array.from(byCategory.entries()).map(([cat, rows]) => {
    const totalSp = rows.reduce((s, r) => s + (r.totalSp ?? 0), 0);
    const delayedItems = rows.filter(
      (r) => r.plannedEnd && addDays(r.plannedEnd, 7) < today
    );
    const atRiskItems = rows.filter(
      (r) => r.plannedEnd && r.plannedEnd <= today && addDays(r.plannedEnd, 7) >= today
    );
    const notStarted = rows.filter((r) => !r.plannedEnd);

    return {
      category: cat,
      total_sp: totalSp,
      task_count: rows.length,
      delayed_count: delayedItems.length,
      at_risk_count: atRiskItems.length,
      not_started_count: notStarted.length,
      delayed_items: delayedItems.map((r) => ({
        item: r.item,
        sp: r.totalSp,
        planned_end: r.plannedEnd
      })),
      at_risk_items: atRiskItems.map((r) => ({
        item: r.item,
        sp: r.totalSp,
        planned_end: r.plannedEnd
      }))
    };
  });

  // This week's planned SP
  const currentWeek = scheduleData.weekDates.filter((d) => d && d <= today).pop() ?? "";
  const thisWeekSp = currentWeek
    ? scheduleData.rows.reduce((sum, r) => {
        const alloc = r.allocations.find((a) => a.weekStart === currentWeek);
        return sum + (alloc?.sp ?? 0);
      }, 0)
    : 0;

  return {
    source: "Google Sheets マスタースケジュール",
    total_tasks: scheduleData.rows.length,
    total_sp: scheduleData.rows.reduce((s, r) => s + (r.totalSp ?? 0), 0),
    this_week_planned_sp: thisWeekSp,
    categories
  };
}

// ── Task-to-Schedule matching ────────────────────────────────────────────

export async function matchTasksToSchedule(
  config: AppConfig,
  summary: SprintTasksSummary,
  scheduleData: ScheduleData
): Promise<TaskScheduleMapping> {
  const allTasks = summary.assignees.flatMap((a) =>
    a.tasks.map((t) => ({
      id: t.id,
      name: t.name,
      status: t.status,
      sp: t.sp,
      category: t.category,
      subItem: t.subItem
    }))
  );

  const scheduleItems = scheduleData.rows.map((r) => ({
    category: r.category,
    item: r.item,
    description: r.description,
    sp: r.totalSp
  }));

  const systemPrompt = `あなたはPMOアシスタントです。Notionのスプリントタスク一覧とGoogle スプレッドシートのスケジュール（大項目・小項目）が与えられます。
各タスクの名前・内容から、最も関連するスプシの大項目と小項目を推測してマッチングしてください。

■ マッチングルール:
- タスク名のキーワード、プレフィックス（【MS】【M】【LF】等）、内容の類似性から判断する
- confidence:
  - "high": タスク名がスプシの小項目とほぼ一致、または明確に同じ作業内容
  - "medium": キーワードや領域が一致しており高い確率で同じ
  - "low": 推測レベル（完全には確信できない）
  - "none": マッチするスプシ項目がない（社内タスク、組織系など）
- マッチしない場合は schedule_category と schedule_item を null にする
- 1つのタスクは最も近い1つのスプシ項目にマッチさせる

日本語で処理してください。`;

  const userPrompt = JSON.stringify({
    notion_tasks: allTasks,
    schedule_items: scheduleItems
  });

  const raw = await callChatCompletion(
    config,
    systemPrompt,
    userPrompt,
    taskScheduleMappingJsonSchema
  );

  return taskScheduleMappingSchema.parse(raw);
}

// ── OpenAI Chat Completions (structured output) ────────────────────────────

async function callChatCompletion(
  config: AppConfig,
  systemPrompt: string,
  userPrompt: string,
  jsonSchema: { name: string; strict: boolean; schema: unknown }
): Promise<unknown> {
  const body = {
    model: config.openaiModel,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    response_format: {
      type: "json_schema",
      json_schema: jsonSchema
    },
    temperature: 0.1
  };

  let attempt = 0;
  let waitMs = 500;

  while (true) {
    attempt++;
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.openaiApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    if (res.ok) {
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content ?? "";
      try {
        return JSON.parse(content);
      } catch {
        throw new Error(`LLM returned invalid JSON: ${content.slice(0, 200)}`);
      }
    }

    if (attempt >= config.maxRetries) {
      const detail = await res.text();
      throw new Error(
        `OpenAI chat completions failed after ${attempt} attempts: ${res.status} ${detail}`
      );
    }
    await new Promise((r) => setTimeout(r, waitMs));
    waitMs *= 2;
  }
}

// ── Step 2: Analyze tasks and members ─────────────────────────────────────

export async function analyzeTasksAndMembers(
  config: AppConfig,
  summary: SprintTasksSummary,
  members: Member[],
  previousSnapshot: Array<{
    id: string;
    name: string;
    status: string | null;
    sp: number | null;
  }>,
  scheduleData?: ScheduleData | null,
  avgDailySp?: number | null,
  stagnantTasks?: Array<{ id: string; name: string; staleDays: number }>,
  taskScheduleMapping?: TaskScheduleMapping | null
): Promise<TaskAnalysis> {
  const today = toJstDateString();

  const judgmentCriteria = avgDailySp != null
    ? `\n■ スケジュール判定基準（過去7日の平均日次消化SP: ${avgDailySp.toFixed(1)}）:
- オンスケ: 残りSP ÷ 残り日数 ≤ ${avgDailySp.toFixed(1)}（今のペースで間に合う）
- 注意: 残りSP ÷ 残り日数 > ${avgDailySp.toFixed(1)}（今のペースだと間に合わない）
- 危険: 期限まで2日以内 かつ 残りSP ÷ 残り日数 > ${avgDailySp.toFixed(1)}（期限直前で間に合わない）
この基準に基づき、各タスク・大項目のスケジュール判定を行ってください。`
    : "";

  const stagnationNote = stagnantTasks && stagnantTasks.length > 0
    ? `\n■ 停滞検出: 以下のDoingタスクは2日以上ステータスが変わっていません。ブロッカーや遅延リスクとしてoverall_summaryと該当担当者のnotesに必ず言及してください。`
    : "";

  const hasMappings = taskScheduleMapping && taskScheduleMapping.mappings.length > 0;
  const hasSchedule = scheduleData && scheduleData.rows.length > 0;

  const systemPrompt = `あなたはPMOアシスタントです。スプリントのタスク状況とメンバーの稼働状況を分析し、
全体サマリー、担当者別状況、スケジュール判定を返してください。
overall_summaryはSlackで読みやすい形式にしてください:
- セクション見出しは【】で囲む。例: 【スプリント消化状況】【リスク項目】
- 大項目名やタスク名は *太字* にする（Slack記法: *テキスト*）
- 箇条書きは ・ を使用（ハイフン - ではなく中黒 ・）
- SP表示は当該スプリントのplan_sp/progress_spを使うこと（マスタースケジュールの全体計画SPではない）
${hasSchedule ? `\nまた、Google スプレッドシートのマスタースケジュール（大項目別の計画SP・週次配分）のデータも提供されています。` : ""}${hasMappings ? `\nNotionタスクとスプシ項目のマッチング結果（task_schedule_mapping）も提供されています。
このマッチングを使って、大項目ごとにNotionのタスク進捗とスプシの計画SPを比較し、オンスケ/遅延判定をoverall_summaryに含めてください。` : ""}${judgmentCriteria}${stagnationNote}
日本語で回答してください。`;

  const scheduleContext = scheduleData
    ? scheduleContextForLlm(scheduleData, today)
    : null;

  const userPrompt = JSON.stringify({
    today,
    sprint: summary.sprint,
    sprint_metrics: summary.sprint_metrics,
    assignees: summary.assignees,
    members: members.map((m) => ({
      name: m.name,
      availableHours: m.availableHours,
      spRate: m.spRate,
      notes: m.notes
    })),
    previous_snapshot_count: previousSnapshot.length,
    status_changes: previousSnapshot
      .map((prev) => {
        const current = summary.assignees
          .flatMap((a) => a.tasks)
          .find((t) => t.id === prev.id);
        if (!current || current.status === prev.status) return null;
        return { id: prev.id, name: prev.name, from: prev.status, to: current.status };
      })
      .filter(Boolean),
    ...(avgDailySp != null ? { avg_daily_sp_7d: avgDailySp } : {}),
    ...(stagnantTasks && stagnantTasks.length > 0
      ? { stagnant_doing_tasks: stagnantTasks }
      : {}),
    ...(scheduleContext ? { master_schedule: scheduleContext } : {}),
    ...(hasMappings ? { task_schedule_mapping: taskScheduleMapping.mappings.filter((m) => m.confidence !== "none") } : {})
  });

  const raw = await callChatCompletion(
    config,
    systemPrompt,
    userPrompt,
    taskAnalysisJsonSchema
  );

  return taskAnalysisSchema.parse(raw);
}

// ── Step 3: Generate per-assignee messages ─────────────────────────────────

export async function generateAssigneeMessages(
  config: AppConfig,
  analysis: TaskAnalysis,
  summary: SprintTasksSummary,
  members: Member[]
): Promise<AssigneeMessages["messages"]> {
  const systemPrompt = `あなたは「土方十四郎」というPMOアシスタントBotです。フレンドリーで頼れる存在として、各担当者に朝の確認メッセージを生成してください。

■ メッセージ生成ルール:
1. 冒頭に「おはようございます、○○さん！」の後に状況の一言サマリーを付ける。必ず「今週期限のタスク」について言及すること
   - 今週期限あり＋期限超過あり → 「今週期限のタスクと期限超過のタスクがあります：」
   - 今週期限あり＋期限超過なし → 「今週期限のタスクは以下です：」
   - 今週期限なし＋期限超過あり → 「今週期限のタスクはありませんが、期限超過のタスクがあります：」
   - 今週期限なし＋期限超過なし＋進行中あり → 「今週期限のタスクはありませんが、進行中のタスクがあります：」
   - 未完了タスクなし → メッセージ生成不要
2. 【期限超過】セクション: 期限 < today のタスクを全件リスト。曖昧な表現は禁止。該当タスクがなければこのセクション自体を省略する
3. 【今週期限】セクション: 期限が week_start〜week_end のタスクを全件リスト。該当タスクがなければこのセクション自体を省略する
4. 【進行中・その他】セクション: 上記いずれにも該当しない未完了タスク（期限が来週以降、または期限未設定のDoing/Ready等）を表示する。該当タスクがなければ省略
5. タスクは各セクションに1回だけ表示する。同じタスクを複数セクションに重複させない。期限超過タスクは【期限超過】にのみ記載し、他セクションには含めない
6. 最後に「今日の作業見込みを教えてください」と依頼する

■ 重要なフォーマットルール:
- 各タスク行にはコメントを付けない。タスク名・期限・ステータスのみ記載する
- コメント（「⏰ 期限過ぎてるけど大丈夫？状況教えて！」「進捗どんな感じ？」等）はセクションの全タスクを列挙した直後に1回だけ添える
- 例:
  【期限超過】
  ・タスクA（期限: 2/10、ステータス: Doing）
  ・タスクB（期限: 2/12、ステータス: Doing）
  ⏰ 期限過ぎてるけど大丈夫？状況教えて！

■ トーン:
- フレンドリーかつ簡潔
- 担当者が返信しやすいよう具体的なタスク名・期限・ステータスを明記する
- プレッシャーをかけすぎず、チームの味方というスタンスで

■ 注意:
- 完了タスクしかない担当者（未完了タスクが0件）にはメッセージを生成しない
- 未完了タスクが1件でもある担当者には必ずメッセージを生成する（今週期限がなくても、期限超過がなくても、進行中タスクがあれば生成する）
- 日本語で書くこと`;

  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const today = toJstDateString(now);
  const dayOfWeek = jst.getUTCDay();
  const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const weekStart = new Date(jst);
  weekStart.setUTCDate(jst.getUTCDate() + diffToMonday);
  const weekEnd = new Date(weekStart);
  weekEnd.setUTCDate(weekStart.getUTCDate() + 6);

  const twoDaysLater = new Date(jst);
  twoDaysLater.setUTCDate(jst.getUTCDate() + 2);

  const userPrompt = JSON.stringify({
    today,
    week_start: weekStart.toISOString().slice(0, 10),
    week_end: weekEnd.toISOString().slice(0, 10),
    deadline_soon_threshold: twoDaysLater.toISOString().slice(0, 10),
    sprint: summary.sprint,
    overall_summary: analysis.overall_summary,
    schedule_status: analysis.schedule_status,
    assignees: summary.assignees.map((a) => ({
      name: a.name,
      tasks: a.tasks,
      analysis: analysis.assignee_analysis.find((aa) => aa.name === a.name)
    })),
    members: members.map((m) => ({
      name: m.name,
      availableHours: m.availableHours
    }))
  });

  const raw = await callChatCompletion(
    config,
    systemPrompt,
    userPrompt,
    assigneeMessagesJsonSchema
  );

  const parsed = assigneeMessagesSchema.parse(raw);
  return parsed.messages;
}

// ── Step 6: Interpret replies and propose allocation ───────────────────────

export async function interpretRepliesAndPropose(
  config: AppConfig,
  analysis: TaskAnalysis,
  replyMap: Map<string, StoredReply[]>,
  activeThreads: ActiveThread[],
  members: Member[],
  scheduleData?: ScheduleData | null,
  summary?: SprintTasksSummary | null,
  avgDailySp?: number | null,
  yesterdayCompletedSp?: number
): Promise<AllocationProposal> {
  const today = toJstDateString();
  const scheduleContext = scheduleData
    ? scheduleContextForLlm(scheduleData, today)
    : null;

  const systemPrompt = `あなたはPMOアシスタントです。各担当者からのSlack返信を解釈し、
稼働状況を把握した上でPM向けの日次レポートを作成してください。
${scheduleContext ? `\nGoogle スプレッドシートのマスタースケジュールデータも提供されています。
pm_reportには以下のセクションを順番に含めてください:

1. 【スケジュール分析】— 以下の形式で固定フォーマット:
  - スプリント名: {sprint.name} ({sprint.start_date} ～ {sprint.end_date})
  - 計画SP: {plan_sp} SP
  - 進捗SP: {progress_sp} SP
  - 残りSP: {remaining_sp} SP
  - 残り日数: {remaining_days} 日
  - 昨日消化SP: {yesterday_completed_sp} SP
  - 必要日次消化SP: {required_sp_per_day} SP/日
  - 過去7日平均消化SP: {avg_daily_sp} SP/日

2. 【メンバー稼働余力】— 各メンバーについて以下を1人1ブロックで表示:
  - 名前
  - 持ちタスク数と合計残SP
  - 過去7日の平均SP消化速度（SP/日）
  - 現ペースで持ちタスクが全て完了する予測日
  - 予測完了日がスプリント終了日より前なら「余力あり」、後なら「タスク過多」と明記する
  - ※「スプリント終了日までの遊休日数」は表示しないこと` : ""}
日本語で回答してください。

■ pm_report フォーマットルール（Slack向け）:
- セクション見出しは【】で囲んでそのまま表示する（例: 【スケジュール分析】）。見出しにバッククォートやアスタリスクは付けない
- 各セクションの中身（箇条書き部分）は \`\`\` で囲んでコードブロックとして表示する。見出しはコードブロックの外に置く
- * (アスタリスク) は一切使用しない
- 箇条書きは ・ を使用する（ - は使用しない）
- セクション間は空行で区切る
- 全体を簡潔かつ一覧性高くする（PMが30秒で把握できるように）
- SP表示は当該スプリントのplan_sp/progress_spを使うこと（マスタースケジュールの全体計画SP600ではなく、スプリント単位のSPで表示する）`;

  const repliesForPrompt = activeThreads.map((t) => ({
    assignee: t.assigneeName,
    replies: replyMap.get(t.assigneeName) ?? []
  }));

  // Build per-member task details for capacity calculation
  const memberTaskDetails = summary ? summary.assignees.map((a) => {
    const incompleteTasks = a.tasks.filter((t) =>
      t.status && !["Done", "完了"].some((s) => t.status!.includes(s))
    );
    const remainingSp = incompleteTasks.reduce((sum, t) => sum + (t.sp ?? 0), 0);
    return {
      name: a.name,
      incomplete_task_count: incompleteTasks.length,
      remaining_sp: remainingSp,
      tasks: incompleteTasks.map((t) => ({
        id: t.id,
        name: t.name,
        status: t.status,
        sp: t.sp,
        due: t.due ?? null
      }))
    };
  }) : [];

  const userPrompt = JSON.stringify({
    today,
    analysis,
    sprint: summary ? {
      name: summary.sprint.name,
      start_date: summary.sprint.start_date,
      end_date: summary.sprint.end_date
    } : null,
    avg_daily_sp_team: avgDailySp,
    yesterday_completed_sp: yesterdayCompletedSp ?? 0,
    members: members.map((m) => ({
      name: m.name,
      availableHours: m.availableHours,
      spRate: m.spRate
    })),
    member_task_details: memberTaskDetails,
    replies: repliesForPrompt,
    note: "返信がない担当者はunavailableとして扱い、その旨をpm_reportに記載してください",
    ...(scheduleContext ? { master_schedule: scheduleContext } : {})
  });

  const raw = await callChatCompletion(
    config,
    systemPrompt,
    userPrompt,
    allocationProposalJsonSchema
  );

  return allocationProposalSchema.parse(raw);
}

// ── Step 8: Interpret PM reply → Notion update actions ────────────────────

export async function interpretPmReply(
  config: AppConfig,
  proposal: AllocationProposal,
  pmReply: string
): Promise<NotionUpdateActions> {
  const systemPrompt = `あなたはPMOアシスタントです。PMの返信を解釈し、
提案されたタスク割り振りへの承認・修正指示をNotionの更新アクションに変換してください。

■ page_id の設定ルール（厳守）:
- page_id には task_allocations 内の task_id フィールド（UUID形式: 例 "abc123-def456-..."）を使用すること
- task_name（日本語のタスク名）を page_id に使用してはいけない
- UUIDはハイフン区切りの英数字文字列である（例: "1a2b3c4d-5e6f-7890-abcd-ef1234567890"）

日本語で回答してください。`;

  // Restructure task_allocations to make the UUID field unmistakable
  const taskAllocationsForLlm = proposal.task_allocations.map((t) => ({
    "page_id（これをactionsのpage_idに使用）": t.task_id,
    task_name: t.task_name,
    current_assignee: t.current_assignee,
    proposed_assignee: t.proposed_assignee,
    reason: t.reason
  }));

  const userPrompt = JSON.stringify({
    pm_reply: pmReply,
    proposal: {
      summary: proposal.summary,
      task_allocations: taskAllocationsForLlm
    },
    note: "PMが「OK」や「承認」と言った場合は全提案を承認、特定のタスクへの指示がある場合はその内容を反映してください"
  });

  const raw = await callChatCompletion(
    config,
    systemPrompt,
    userPrompt,
    notionUpdateActionsJsonSchema
  );

  return notionUpdateActionsSchema.parse(raw);
}

// ── @mention intent interpreter ────────────────────────────────────────────

export async function interpretMention(
  config: AppConfig,
  userText: string,
  summary: SprintTasksSummary,
  context: MentionContext,
  requestUserName?: string,
  conversationHistory?: MentionMessage[],
  pendingCreateTasks?: Array<{ task_name: string; assignee: string; due: string; sp: number; status: string; project: string | null; description: string | null; sprint: string | null }> | null,
  pendingUpdateActions?: Array<{ action: string; page_id: string; task_name: string; new_value: string }> | null,
  threadContext?: Array<{ text: string; user: string }>,
  channelContext?: Array<{ text: string; user: string }>,
  referenceItems?: ReferenceItem[]
): Promise<MentionIntent> {
  const systemPrompt = `あなたは「土方十四郎」というPMOアシスタントBotです。フレンドリーで少しユーモアがあり、チームの頼れる存在です。
ユーザーからの@メンションを解釈し、以下のいずれかを判断してください。

**query（情報照会）**: タスク状況の確認・質問への回答
- response_textに日本語で回答を生成（タスク一覧、進捗、担当者情報など）
- actionsは空配列 []、new_tasksは空配列 []
- 「今週」はuser_promptのweek_startからweek_endまでの期間を指す（必ずこの値を使うこと）
- 以下の情報がコンテキストとして提供されています。質問に関連するデータを使って回答してください:
  - sprint_metrics: スプリント消化率（計画SP、進捗SP、残りSP、必要SP/日）
  - avg_daily_sp: 過去7日の平均日次消化SP（🟢🟡🔴判定に使用）
  - members: メンバーの残り稼働時間(remainingHours)・合計稼働時間(totalHours)・1SPあたり必要時間(hoursPerSp)・現在のタスク数/SP・必要工数(requiredHours)・稼働率%(utilization) で空き状況を判断
  - schedule_deviation: スケジュール進捗（オンスケ/遅延/リスク件数・該当項目）
  - weekly_diff: 週次比較（7日間の完了タスク・新規タスク・SP合計）
  - stagnant_tasks: 2日以上ステータス変更のないDoingタスク
  - available_sprints: 利用可能なスプリント一覧（スプリント移動に使用）
  - reference_db: 参照用Notionデータベースの全項目（読み取り専用）。タスク作成時のdescription充実化や関連タスクの発見に活用する。⚠️ このDBへの書き込み・更新は絶対に行わない
- スケジュール判定: avg_daily_spがある場合、残りSP÷残り日数とavg_daily_spを比較して「オンスケ」「注意」「危険」で判定
- シミュレーション: 「○○さんが休んだら？」→ そのメンバーのタスクSPを他メンバーに再配分した場合の影響を推定
- 「自分」「私」「俺」等の一人称は、request_user（発言者）を指す。request_user.nameの担当タスクで回答すること

**update（更新指示）**: Notionのタスク更新リクエスト
- response_textに確認メッセージを生成。**必ず以下の形式でマッチしたタスクの詳細を含めること**:
  対象タスク: 「{タスク名}」（担当: {担当者}、現在のステータス: {status}、期限: {due}、SP: {sp}）
  変更内容: {変更項目} {現在の値} → {新しい値}
  問題なければ ✅ をリアクションしてください
- actionsに実行するNotion更新アクションを配列で返す
- page_idはタスクリストに含まれるIDを必ず使用する（存在しないIDは使わない）
- ユーザーの指示が曖昧で複数タスクに該当しうる場合は、候補を列挙してどのタスクか確認する（intent="query"、actionsは空）
- new_tasksは空配列 []

**update_sprint（スプリント移動）**: タスクを別スプリントに移動、またはバックログに戻す
- action = "update_sprint"
- new_valueにはavailable_sprintsのIDを使用する。バックログ戻しの場合はnew_value = ""（空文字）
- response_textに確認メッセージを生成（対象タスクの詳細 + 移動先スプリント名を明記）
- intent = "update"（updateとして扱う）

**create_task（タスク追加）**: 新しいタスクをNotionに追加するリクエスト
- 必須項目: task_name（タスク名）、assignee（担当者名）、due（期限 YYYY-MM-DD）、sp（SP）
- オプション項目: project（プロジェクト名）- ユーザーが指定した場合のみセット、未指定ならnull
- オプション項目: description（概要）- システムが自動生成した概要。ユーザーが修正を依頼した場合のみ変更する
- オプション項目: sprint（スプリント名）- available_sprintsに含まれるスプリント名を指定する。ユーザーが「スプリントに入れて」「現スプリントに追加」等と指定した場合にセットする。未指定またはユーザーが「スプリントはまだ設定しないで」「バックログにして」等と指示した場合はnull（バックログとして起票される）。デフォルトはnull
- 複数タスクの同時作成に対応: スレッド内容から複数のタスクが識別できる場合、new_tasksに複数のタスクを含める
- ⚠️ タスク情報の出典ルール（厳守）:
  - task_nameはuser_message、thread_context、channel_context、current_tasksのいずれかに根拠があること
  - thread_contextにTODO項目や作業内容がある場合、それをタスクとして起票する（スレッド内の情報を最優先で活用する）
  - どこにも存在しないタスク名を捏造してはならない
- 全ての必須項目が揃っている場合:
  - intent = "create_task"
  - response_textに確認メッセージを生成（全タスクの詳細を一覧表示 + 「✅ をリアクションしてください」）
  - response_textに📝概要は含めない（システム側で別途表示する）
  - new_tasksに作成するタスク情報を配列でセット、各タスクのstatusは "Ready"
  - descriptionは新規作成時はnull（システムが後から自動生成する）。thread_contextがある場合はスレッド内容から推測した概要をセット
- 必須項目が不足している場合:
  - intent = "create_task"
  - response_textに不足項目を質問するメッセージを生成（「タスク名と期限は分かりましたが、担当者とSPを教えてください！」）
  - new_tasksは空配列 []（情報が揃うまで作成しない）
- actionsは空配列 []

**unknown（雑談・その他）**: タスクに関係ない会話や挨拶
- フレンドリーに返答する（例: 「やほ！」→「やほ！何かお手伝いできることある？😄」）
- PMOアシスタントとしての個性を出しつつ自然に会話する
- actionsは空配列 []、new_tasksは空配列 []

■ 保留中のタスク作成の修正:
- pending_create_tasksが提供されている場合、ユーザーは確認待ちのタスク作成に対する修正を依頼している可能性が高い
- プロジェクト変更、担当者変更、期限変更、SP変更、スプリント変更など、修正内容を特定できたら:
  - intent="create_task"で、pending_create_tasksをベースに変更点を反映したnew_tasksを返す
  - response_textに修正後のタスク詳細と「✅をリアクションしてください」を含める（📝概要はresponse_textに含めない）
  - actionsは空配列 []
- 概要（description）の修正:
  - 「概要を○○にして」「概要修正: ○○」→ 該当タスクのdescriptionに修正後のテキストをセット
  - 「概要なし」「概要を削除」「スキップ」→ descriptionをnullにセット
  - 概要に言及していない修正の場合 → pending_create_tasksのdescriptionをそのまま引き継ぐ
- スプリント（sprint）の修正:
  - 「スプリントに入れて」「現スプリントに追加」→ available_sprintsから該当スプリント名をsprintにセット
  - 「スプリントはまだ設定しないで」「バックログにして」「スプリント外して」→ sprintをnullにセット
  - スプリントに言及していない修正の場合 → pending_create_tasksのsprintをそのまま引き継ぐ
- 概要のヒアリング（pending_create_tasksのdescriptionがnullの場合）:
  - ユーザーがタスクの背景・目的・詳細を説明するテキストを返信した場合:
    → その内容を200字以内で簡潔にまとめてdescriptionにセット
    → intent="create_task"で、pending_create_tasksをベースにdescriptionを追加したnew_tasksを返す
    → response_textに確認メッセージ + 「✅をリアクションしてください」を含める
- 重要: pending_create_tasksがある場合、updateアクション（update_assignee, update_due等）に変換しないこと。タスクはまだNotionに存在しないため、既存タスクの更新はできない

■ 保留中の更新アクションの修正:
- pending_update_actionsが提供されている場合、確認待ちの更新アクションが存在する
- ユーザーが追加の変更を依頼した場合: 既存のアクションに新しいアクションを追加してactionsに全て含める
- ユーザーが既存アクションの変更を依頼した場合: 該当アクションを修正版に置き換える
- ユーザーがキャンセルを依頼した場合: intent="unknown"でキャンセル確認メッセージを返す
- intent="update"で、修正後の全アクションをactionsに含め、response_textに更新内容一覧と「✅をリアクションしてください」を含める

■ スレッドからのタスク自動起票:
- thread_contextが提供されている場合、ユーザーはスレッド内の会話をもとにタスクを作成したいと考えている
- ⚠️ 最重要ルール: タスク情報はスレッド内の実際の内容に基づくこと
  - task_nameは必ずthread_context内に存在するTODO項目・作業内容・機能名・議題などから抽出すること
  - thread_contextやuser_message、channel_context、current_tasksのどこにも言及されていないタスク名を作り出してはならない（捏造禁止）
  - 例: スレッドに「休暇簿ツール」「陸DXプロジェクト」「防衛プロジェクト」が書かれている場合、これらをタスクとして起票する。「PMObot修正」のようなスレッドに存在しない名前を作り出すのはNG
- タスク起票の手順:
  1. まずthread_contextを精読し、TODO項目・作業依頼・機能要望・議論されているテーマを全て洗い出す
  2. conversation_historyやthread_context内で既にボットがタスク作成確認を送信済みの項目は除外する
  3. 残った項目についてchannel_context（チャンネル全体の他スレッド）とcurrent_tasks（Notionの既存タスク）を確認し、関連する情報を収集する
  4. 収集した情報をもとに、各タスクのdescriptionを充実させる
  5. スレッドに具体的なタスク内容が一つも見つからない場合のみ、intent="create_task" + new_tasks=[] で質問する
- タスクの粒度: 過度に細分化しない。1つの機能・1つのテーマに関する作業は1タスクにまとめる
  - 例: 「差分の表示を赤枠にして、追加/削除のマーキング追加して、ページ追加時のアラートもつけて」
    → これは全て「差分表示」に関する作業なので「差分表示の改善（赤枠・マーキング・アラート対応）」の1タスクにまとめる
  - 明確に別テーマ・別担当の作業が含まれる場合のみ複数タスクに分ける
  - 例: 「仕様書作成と画面のUI修正」→ 別テーマなので2タスクに分ける
- 起票対象の判定（厳守）: 起票するのは自チームメンバー（membersに含まれる人）が実施する作業のみ
  - membersに含まれない人物（クライアント、外部ベンダー、他部署など）が主語・実行者のタスクは絶対に起票しない
  - 判定方法: タスクの実行者がmembersのname一覧に存在するか確認する。存在しなければ起票対象外
  - 例（起票しない）: 「先方に仕様確認を依頼」「クライアントが検証する」「○○社の回答待ち」「顧客へヒアリング」
  - 例（起票する）: 「仕様書を作成する」「画面のUI修正」「テストコードを書く」（自チームの作業）
  - 迷う場合: 起票しない。自チームが明確に手を動かす作業のみ起票する
- 担当者（assignee）の決定ルール（厳守）:
  - スレッド内で @ユーザー名 が明示されている場合、その人物が担当者。「○○さんが確認する」「○○さんにメールもらう」等の文脈上の言及は担当者指定ではない
  - 例: 「@Takeda Ryohei @Tomoya Kotetsu」→ 担当者は Takeda と Kotetsu
  - 例: 「押田さんが確認してメールもらう」→ 押田さんは先方の人。担当者ではない。これは単なる補足情報
  - assigneeには必ずmembersに存在する名前のみをセットすること。membersにいない人は担当者にできない
- 各タスクの項目設定（assignee以外は自動で具体的に埋める）:
  - task_name: スレッド内の具体的な記述から抽出する（捏造禁止）
  - due: 議論内容に期限の言及があればそれを使用。なければスプリント終了日を使う
  - sp: タスクの複雑さ・規模から推測（1〜5程度）。分解した場合は各タスクごとに適切なSPを設定
  - description: スレッドの議論内容 + channel_contextやcurrent_tasksから見つけた関連情報を組み合わせて、背景・目的・やるべきことを200字以内で具体的に要約する
  - project: スレッド内にプロジェクト名の言及があればセット。なければchannel_contextやcurrent_tasksから関連プロジェクトを推測してセット。それでも不明ならnull
  - assignee（担当者）: PMに確認を取る。以下の手順に従う:
    1. スレッド内で「○○さんお願い」「@○○」等の明示的な指名がある場合 → その人をassigneeにセットし、通常通り確認メッセージを送る
    2. 明示的な指名がない場合 → channel_context（チャンネル全体の発言）とcurrent_tasks（Notionの既存タスク）を分析し、そのタスクのテーマに最も知見がありそうなメンバーを候補として提案する。ただしassigneeは確定せず、PMに確認を取る
       - intent="create_task"、new_tasks=[]（まだ確定しない）
       - response_textにtask_name、due、sp、projectなど担当者以外の項目を全て表示した上で、「担当者は○○さん（理由: △△の知見あり）を提案しますが、誰にしますか？」と質問する
       - 知見の判断基準: 同じトピックについてチャンネルで発言している、同じプロジェクト/機能の既存タスクを担当している、関連する技術領域で活動している等
       - 候補が複数いる場合は理由付きで列挙し、PMに選んでもらう
    3. PMが担当者を回答したら → conversation_historyの文脈から全項目が揃うので、new_tasksに完成したタスクをセットして確認メッセージを送る
- ユーザーが明示的に指定した項目（「担当は○○」「SPは3で」など）があれば、推測より優先する
- 関連情報の収集（タスク内容の充実化に必ず活用すること）:
  - channel_context（チャンネル内の他スレッドのメッセージ）から、タスクと同じトピックに関連する議論・決定事項・補足情報を探す
  - current_tasks（Notionの既存タスク）に同じプロジェクト・機能に関連するタスクがあれば、descriptionで言及する（例: 「関連タスク: ○○」）
  - reference_db（参照用Notionデータベース）に関連する項目があれば、descriptionに背景情報として含める。⚠️ reference_dbはあくまで参照専用。ここへの起票・更新は絶対にしない
  - これらの関連情報はdescriptionに反映し、タスクの背景をより豊かにする

■ 会話の継続:
- conversation_historyが提供されている場合、直前のやりとりの文脈を踏まえて回答すること
- 「その中で」「それの」「さっきの」等の指示語は、直前の会話内容を参照して解釈する
- 例: 前回「古鉄さんのタスク状況」→ 今回「その中で着手中は？」→ 古鉄さんのタスクのうちDoing/進行中のものを回答

■ フォーマットルール（Slack向け）:
- セクション見出しは【】で囲む。例: 【タスク一覧】【消化率】【メンバー稼働状況】
- 大項目名やタスク名は *太字* にする（Slack記法: *テキスト*）
- 重要な数値は *太字* にする
- 箇条書きは ・ を使用（ハイフン - ではなく中黒 ・）
- 全体を簡潔に保つ

タスクリストに存在しないタスクへの更新指示の場合は、その旨をresponse_textに記載しintentをunknownにしてください。
担当者変更の場合のnew_valueは担当者名（日本語）を使用してください。
日付はYYYY-MM-DD形式で返してください。
日本語で回答してください。`;

  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const today = toJstDateString(now);

  // 今週の月曜〜日曜を計算（JST基準）
  const dayOfWeek = jst.getUTCDay(); // 0=日, 1=月, ..., 6=土
  const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const weekStart = new Date(jst);
  weekStart.setUTCDate(jst.getUTCDate() + diffToMonday);
  const weekEnd = new Date(weekStart);
  weekEnd.setUTCDate(weekStart.getUTCDate() + 6);

  const hasHistory = conversationHistory && conversationHistory.length > 0;

  const userPrompt = JSON.stringify({
    user_message: userText,
    today,
    week_start: weekStart.toISOString().slice(0, 10),
    week_end: weekEnd.toISOString().slice(0, 10),
    ...(requestUserName ? { request_user: { name: requestUserName } } : {}),
    ...(hasHistory ? { conversation_history: conversationHistory } : {}),
    sprint: summary.sprint,
    current_tasks: summary.assignees.map((a) => ({
      assignee: a.name,
      tasks: a.tasks.map((t) => ({
        id: t.id,
        name: t.name,
        status: t.status,
        sp: t.sp,
        due: t.due,
        priority: t.priority
      }))
    })),
    sprint_metrics: context.sprintMetrics,
    avg_daily_sp: context.avgDailySp,
    members: context.members,
    schedule_deviation: context.scheduleDeviation,
    weekly_diff: context.weeklyDiff,
    stagnant_tasks: context.stagnantTasks,
    available_sprints: context.availableSprints,
    ...(pendingCreateTasks && pendingCreateTasks.length > 0 ? { pending_create_tasks: pendingCreateTasks } : {}),
    ...(pendingUpdateActions ? { pending_update_actions: pendingUpdateActions } : {}),
    ...(threadContext && threadContext.length > 0 ? { thread_context: threadContext } : {}),
    ...(channelContext && channelContext.length > 0 ? { channel_context: channelContext } : {}),
    ...(referenceItems && referenceItems.length > 0 ? { reference_db: referenceItems } : {})
  });

  const raw = await callChatCompletion(
    config,
    systemPrompt,
    userPrompt,
    mentionIntentJsonSchema
  );

  return mentionIntentSchema.parse(raw);
}

// ── Evaluate assignee reply quality ────────────────────────────────────────

export async function evaluateAssigneeReply(
  config: AppConfig,
  replyText: string,
  assigneeName: string,
  tasks: Array<{ name: string; status: string | null; sp: number | null }>
): Promise<boolean> {
  const systemPrompt = `あなたはPMOアシスタントです。担当者からの返信が「今日の作業見込み」として具体的かどうかを判定してください。

■ OK（is_valid: true）の基準:
- 具体的なタスク名や作業内容に言及している
- 「〇〇を進めます」「〇〇は完了見込み」「今日は〇〇に着手」等の具体的な予定がある
- 困っていること・ブロッカーの報告も有効な返信とみなす

■ NG（is_valid: false）の基準:
- 「了解」「OK」「はい」だけで具体性がない
- 何をするか・どう進めるかの情報が一切ない
- 無関係な内容

短い返信でも、何をやるかが読み取れればOKとする。`;

  const userPrompt = JSON.stringify({
    assignee: assigneeName,
    reply: replyText,
    assigned_tasks: tasks
  });

  const raw = await callChatCompletion(
    config,
    systemPrompt,
    userPrompt,
    replyEvaluationJsonSchema
  );

  const result = replyEvaluationSchema.parse(raw);
  return result.is_valid;
}

// ── Generate task description from related Slack messages ──────────────────

export async function generateTaskDescription(
  config: AppConfig,
  taskName: string,
  relatedMessages: Array<{ text: string; user: string; ts: string }>
): Promise<string | null> {
  if (relatedMessages.length === 0) return null;

  const systemPrompt = `あなたはPMOアシスタントです。Slackチャンネル内のメッセージ一覧から、指定されたタスクに関連する情報を見つけ出し、タスクの概要を作成してください。

ルール:
・まずメッセージ一覧の中からタスクに関連しそうなものを意味的に判断して抽出する
・部分一致だけでなく、タスクの目的・背景・技術領域などの意味合いで関連するものも拾う
・関連メッセージが見つかったら、200字以内で概要を作成する（背景・目的・やるべきことが分かるように）
・関連するメッセージが一つも見つからない場合のみ「null」とだけ返す
・日本語で記述する`;

  const userPrompt = `タスク名: ${taskName}

チャンネル内の直近メッセージ:
${relatedMessages.map((m) => `[${m.user}] ${m.text}`).join("\n")}

上記メッセージの中からタスクに関連する情報を探し、概要を作成してください。関連するものが一つもない場合のみ「null」と返してください。`;

  const body = {
    model: config.openaiModel,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    temperature: 0.2,
    max_tokens: 500
  };

  let attempt = 0;
  let waitMs = 500;

  while (true) {
    attempt++;
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.openaiApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    if (res.ok) {
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = (data.choices?.[0]?.message?.content ?? "").trim();
      if (!content || content.toLowerCase() === "null") return null;
      return content;
    }

    if (attempt >= config.maxRetries) {
      console.warn(`generateTaskDescription failed after ${attempt} attempts`);
      return null; // Don't block task creation on description failure
    }
    await new Promise((r) => setTimeout(r, waitMs));
    waitMs *= 2;
  }
}
