import { z } from "zod";

const sprintSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  status: z.string().min(1)
});

const metricSchema = z.object({
  key: z.string().min(1),
  value: z.union([z.number(), z.string()])
});

const sprintResponseSchema = z.object({
  sprint: sprintSchema,
  metrics: z.array(metricSchema).default([]),
  notes: z.array(z.string().min(1)).default([])
});

export type SprintSummary = z.infer<typeof sprintResponseSchema>;

export const openAiJsonSchema = {
  name: "SprintSummary",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      sprint: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          start_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          end_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          status: { type: "string" }
        },
        required: ["id", "name", "start_date", "end_date", "status"]
      },
      metrics: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            key: { type: "string" },
            value: { type: ["number", "string"] }
          },
          required: ["key", "value"]
        }
      },
      notes: { type: "array", items: { type: "string" } }
    },
    required: ["sprint", "metrics", "notes"]
  }
};

export const sprintTasksSchema = z.object({
  sprint: sprintSchema,
  sprint_metrics: z.object({
    plan_sp: z.number().optional().nullable(),
    progress_sp: z.number().optional().nullable(),
    required_sp_per_day: z.number().optional().nullable()
  }),
  assignees: z.array(
    z.object({
      name: z.string().min(1),
          tasks: z.array(
        z.object({
          id: z.string().min(1),
          name: z.string().min(1),
          status: z.string().optional().nullable(),
          priority: z.string().optional().nullable(),
          sp: z.number().optional().nullable(),
          due: z.string().optional().nullable(),
          startDate: z.string().optional().nullable(),
          category: z.string().optional().nullable(),
          subItem: z.string().optional().nullable(),
          company: z.string().optional().nullable(),
          url: z.string().url().optional().nullable()
        })
      )
    })
  ),
  projectIds: z.array(z.string()).default([])
});

export type SprintTasksSummary = z.infer<typeof sprintTasksSchema>;

export const sprintTasksJsonSchema = {
  name: "SprintTasksSummary",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      sprint: openAiJsonSchema.schema.properties.sprint,
      sprint_metrics: {
        type: "object",
        additionalProperties: false,
        properties: {
          plan_sp: { type: ["number", "null"] },
          progress_sp: { type: ["number", "null"] },
          required_sp_per_day: { type: ["number", "null"] }
        },
        required: ["plan_sp", "progress_sp", "required_sp_per_day"]
      },
      assignees: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string" },
            tasks: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  id: { type: "string" },
                  name: { type: "string" },
                  status: { type: ["string", "null"] },
                  priority: { type: ["string", "null"] },
                  sp: { type: ["number", "null"] },
                  due: { type: ["string", "null"] },
                  startDate: { type: ["string", "null"] },
                  category: { type: ["string", "null"] },
                  subItem: { type: ["string", "null"] },
                  company: { type: ["string", "null"] },
                  url: { type: ["string", "null"] }
                },
                required: ["id", "name", "status", "priority", "sp", "due"]
              }
            }
          },
          required: ["name", "tasks"]
        }
      }
    },
    required: ["sprint", "sprint_metrics", "assignees"]
  }
};

export function validateSprintTasks(payload: unknown): SprintTasksSummary {
  return sprintTasksSchema.parse(payload);
}

export function validateResponse(payload: unknown): SprintSummary {
  return sprintResponseSchema.parse(payload);
}

// ── Mention context (rich data for @mention handler) ──────────────────────

export interface MentionContext {
  sprintMetrics: {
    plan_sp: number | null;
    progress_sp: number | null;
    remaining_sp: number | null;
    required_sp_per_day: number | null;
  };
  avgDailySp: number | null;
  members: Array<{
    name: string;
    remainingHours: number | null;
    totalHours: number | null;
    hoursPerSp: number;
    currentTaskCount: number;
    currentTotalSp: number;
    requiredHours: number;
    utilization: number | null;
  }>;
  scheduleDeviation: {
    onTrack: number;
    delayed: number;
    atRisk: number;
    delayedItems: Array<{ category: string; item: string; plannedEnd: string }>;
    atRiskItems: Array<{ category: string; item: string; plannedEnd: string }>;
  } | null;
  weeklyDiff: {
    periodStart: string;
    periodEnd: string;
    completedTasks: Array<{ id: string; name: string; sp: number | null }>;
    totalCompletedSp: number;
    newTasks: Array<{ id: string; name: string; sp: number | null }>;
    totalNewSp: number;
  } | null;
  stagnantTasks: Array<{ id: string; name: string; staleDays: number }>;
  availableSprints: Array<{
    id: string;
    name: string;
    start_date: string;
    end_date: string;
  }>;
}

// ── PMO Agent schemas ──────────────────────────────────────────────────────

const memberSchema = z.object({
  name: z.string().min(1),
  slackUserId: z.string().optional(),
  availableHours: z.number().optional(),
  spRate: z.number().default(1),
  notes: z.string().optional()
});
export type Member = z.infer<typeof memberSchema>;

export const taskAnalysisSchema = z.object({
  overall_summary: z.string(),
  schedule_status: z.enum(["on_track", "at_risk", "behind"]),
  assignee_analysis: z.array(
    z.object({
      name: z.string(),
      task_count: z.number(),
      total_sp: z.number().nullable(),
      overload_risk: z.enum(["low", "medium", "high"]),
      notes: z.string()
    })
  ),
  recommendations: z.array(z.string())
});
export type TaskAnalysis = z.infer<typeof taskAnalysisSchema>;

export const taskAnalysisJsonSchema = {
  name: "TaskAnalysis",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      overall_summary: { type: "string" },
      schedule_status: { type: "string", enum: ["on_track", "at_risk", "behind"] },
      assignee_analysis: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string" },
            task_count: { type: "number" },
            total_sp: { type: ["number", "null"] },
            overload_risk: { type: "string", enum: ["low", "medium", "high"] },
            notes: { type: "string" }
          },
          required: ["name", "task_count", "total_sp", "overload_risk", "notes"]
        }
      },
      recommendations: { type: "array", items: { type: "string" } }
    },
    required: ["overall_summary", "schedule_status", "assignee_analysis", "recommendations"]
  }
};

export const assigneeMessagesSchema = z.object({
  messages: z.array(
    z.object({
      assignee_name: z.string(),
      message_text: z.string()
    })
  )
});
export type AssigneeMessages = z.infer<typeof assigneeMessagesSchema>;

export const assigneeMessagesJsonSchema = {
  name: "AssigneeMessages",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      messages: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            assignee_name: { type: "string" },
            message_text: { type: "string" }
          },
          required: ["assignee_name", "message_text"]
        }
      }
    },
    required: ["messages"]
  }
};

export const allocationProposalSchema = z.object({
  summary: z.string(),
  reply_interpretations: z.array(
    z.object({
      assignee_name: z.string(),
      capacity: z.enum(["available", "limited", "unavailable"]),
      available_hours: z.number().nullable(),
      notes: z.string()
    })
  ),
  task_allocations: z.array(
    z.object({
      task_id: z.string(),
      task_name: z.string(),
      current_assignee: z.string().nullable(),
      proposed_assignee: z.string().nullable(),
      reason: z.string()
    })
  ),
  pm_report: z.string()
});
export type AllocationProposal = z.infer<typeof allocationProposalSchema>;

export const allocationProposalJsonSchema = {
  name: "AllocationProposal",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      summary: { type: "string" },
      reply_interpretations: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            assignee_name: { type: "string" },
            capacity: { type: "string", enum: ["available", "limited", "unavailable"] },
            available_hours: { type: ["number", "null"] },
            notes: { type: "string" }
          },
          required: ["assignee_name", "capacity", "available_hours", "notes"]
        }
      },
      task_allocations: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            task_id: { type: "string" },
            task_name: { type: "string" },
            current_assignee: { type: ["string", "null"] },
            proposed_assignee: { type: ["string", "null"] },
            reason: { type: "string" }
          },
          required: ["task_id", "task_name", "current_assignee", "proposed_assignee", "reason"]
        }
      },
      pm_report: { type: "string" }
    },
    required: ["summary", "reply_interpretations", "task_allocations", "pm_report"]
  }
};

export const notionUpdateActionsSchema = z.object({
  actions: z.array(
    z.object({
      action: z.enum(["update_assignee", "update_due", "update_sp", "update_status"]),
      page_id: z.string(),
      task_name: z.string(),
      new_value: z.string()
    })
  ),
  summary: z.string()
});
export type NotionUpdateActions = z.infer<typeof notionUpdateActionsSchema>;

const newTaskSchema = z.object({
  task_name: z.string(),
  assignee: z.string(),
  due: z.string(),
  sp: z.number(),
  status: z.string().default("Ready"),
  project: z.string().nullable().default(null)
});
export type NewTask = z.infer<typeof newTaskSchema>;

export const mentionIntentSchema = z.object({
  intent: z.enum(["query", "update", "create_task", "unknown"]),
  response_text: z.string(),
  actions: z.array(
    z.object({
      action: z.enum(["update_assignee", "update_due", "update_sp", "update_status", "update_sprint"]),
      page_id: z.string(),
      task_name: z.string(),
      new_value: z.string()
    })
  ),
  new_tasks: z.array(
    z.object({
      task_name: z.string(),
      assignee: z.string(),
      due: z.string(),
      sp: z.number(),
      status: z.string(),
      project: z.string().nullable(),
      description: z.string().nullable()
    })
  )
});
export type MentionIntent = z.infer<typeof mentionIntentSchema>;

export const mentionIntentJsonSchema = {
  name: "MentionIntent",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      intent: { type: "string", enum: ["query", "update", "create_task", "unknown"] },
      response_text: { type: "string" },
      actions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            action: {
              type: "string",
              enum: ["update_assignee", "update_due", "update_sp", "update_status", "update_sprint"]
            },
            page_id: { type: "string" },
            task_name: { type: "string" },
            new_value: { type: "string" }
          },
          required: ["action", "page_id", "task_name", "new_value"]
        }
      },
      new_tasks: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            task_name: { type: "string" },
            assignee: { type: "string" },
            due: { type: "string" },
            sp: { type: "number" },
            status: { type: "string" },
            project: { type: ["string", "null"] },
            description: { type: ["string", "null"] }
          },
          required: ["task_name", "assignee", "due", "sp", "status", "project", "description"]
        }
      }
    },
    required: ["intent", "response_text", "actions", "new_tasks"]
  }
};

// ── Task-to-Schedule matching schema ─────────────────────────────────────

export const taskScheduleMappingSchema = z.object({
  mappings: z.array(
    z.object({
      task_id: z.string(),
      task_name: z.string(),
      schedule_category: z.string().nullable(),
      schedule_item: z.string().nullable(),
      confidence: z.enum(["high", "medium", "low", "none"])
    })
  )
});
export type TaskScheduleMapping = z.infer<typeof taskScheduleMappingSchema>;

export const taskScheduleMappingJsonSchema = {
  name: "TaskScheduleMapping",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      mappings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            task_id: { type: "string" },
            task_name: { type: "string" },
            schedule_category: { type: ["string", "null"] },
            schedule_item: { type: ["string", "null"] },
            confidence: { type: "string", enum: ["high", "medium", "low", "none"] }
          },
          required: ["task_id", "task_name", "schedule_category", "schedule_item", "confidence"]
        }
      }
    },
    required: ["mappings"]
  }
};

export const notionUpdateActionsJsonSchema = {
  name: "NotionUpdateActions",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      actions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            action: {
              type: "string",
              enum: ["update_assignee", "update_due", "update_sp", "update_status"]
            },
            page_id: { type: "string" },
            task_name: { type: "string" },
            new_value: { type: "string" }
          },
          required: ["action", "page_id", "task_name", "new_value"]
        }
      },
      summary: { type: "string" }
    },
    required: ["actions", "summary"]
  }
};

// ── Reply evaluation schema ─────────────────────────────────────────────

export const replyEvaluationSchema = z.object({
  is_valid: z.boolean()
});
export const replyEvaluationJsonSchema = {
  name: "ReplyEvaluation",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      is_valid: { type: "boolean" }
    },
    required: ["is_valid"]
  }
};
