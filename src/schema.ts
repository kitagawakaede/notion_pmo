import { z } from "zod";

export const sprintSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  status: z.string().min(1)
});

export const metricSchema = z.object({
  key: z.string().min(1),
  value: z.union([z.number(), z.string()])
});

export const sprintResponseSchema = z.object({
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
          url: z.string().url().optional().nullable()
        })
      )
    })
  )
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
