import { zValidator } from "@hono/zod-validator";

import { Hono } from "hono";
import { v4 as uuid4 } from "uuid";

import * as schemas from "../schemas.mjs";
import { type RunnableConfig, Threads } from "../storage/ops.mjs";
import { z } from "zod";
import { stateSnapshotToThreadState } from "../state.mjs";
import { jsonExtra } from "../utils/hono.mjs";

const api = new Hono();

// Threads Routes
api.post("/threads", zValidator("json", schemas.ThreadCreate), async (c) => {
  // Create Thread
  const payload = c.req.valid("json");
  const thread = await Threads.put(payload.thread_id || uuid4(), {
    metadata: payload.metadata,
    if_exists: payload.if_exists ?? "raise",
  });

  return jsonExtra(c, thread);
});

api.post(
  "/threads/search",
  zValidator("json", schemas.ThreadSearchRequest),
  async (c) => {
    // Search Threads
    const payload = c.req.valid("json");
    const result: unknown[] = [];

    for await (const item of Threads.search({
      status: payload.status,
      values: payload.values,
      metadata: payload.metadata,
      limit: payload.limit ?? 10,
      offset: payload.offset ?? 0,
    })) {
      result.push({
        ...item,
        created_at: item.created_at.toISOString(),
        updated_at: item.updated_at.toISOString(),
      });
    }

    return jsonExtra(c, result);
  },
);

api.get(
  "/threads/:thread_id/state",
  zValidator("param", z.object({ thread_id: z.string().uuid() })),
  zValidator(
    "query",
    z.object({ subgraphs: schemas.coercedBoolean.optional() }),
  ),
  async (c) => {
    // Get Latest Thread State
    const { thread_id } = c.req.valid("param");
    const { subgraphs } = c.req.valid("query");

    const state = stateSnapshotToThreadState(
      await Threads.State.get({ configurable: { thread_id } }, { subgraphs }),
    );

    return jsonExtra(c, state);
  },
);

api.post(
  "/threads/:thread_id/state",
  zValidator("param", z.object({ thread_id: z.string().uuid() })),
  zValidator(
    "json",
    z.object({
      values: z
        .union([
          z.record(z.string(), z.unknown()),
          z.array(z.record(z.string(), z.unknown())),
        ])
        .nullish(),
      as_node: z.string().optional(),
      checkpoint_id: z.string().optional(),
      checkpoint: schemas.CheckpointSchema.nullish(),
    }),
  ),
  async (c) => {
    // Update Thread State
    const { thread_id } = c.req.valid("param");
    const payload = c.req.valid("json");
    const config: RunnableConfig = { configurable: { thread_id } };

    if (payload.checkpoint_id) {
      config.configurable ??= {};
      config.configurable.checkpoint_id = payload.checkpoint_id;
    }
    if (payload.checkpoint) {
      config.configurable ??= {};
      Object.assign(config.configurable, payload.checkpoint);
    }

    const inserted = await Threads.State.post(
      config,
      payload.values,
      payload.as_node,
    );

    return jsonExtra(c, inserted);
  },
);

api.get(
  "/threads/:thread_id/state/:checkpoint_id",
  zValidator(
    "param",
    z.object({
      thread_id: z.string().uuid(),
      checkpoint_id: z.string().uuid(),
    }),
  ),
  zValidator(
    "query",
    z.object({ subgraphs: schemas.coercedBoolean.optional() }),
  ),
  async (c) => {
    // Get Thread State At Checkpoint
    const { thread_id, checkpoint_id } = c.req.valid("param");
    const { subgraphs } = c.req.valid("query");
    const state = stateSnapshotToThreadState(
      await Threads.State.get(
        { configurable: { thread_id, checkpoint_id } },
        { subgraphs },
      ),
    );

    return jsonExtra(c, state);
  },
);

api.post(
  "/threads/:thread_id/state/checkpoint",
  zValidator("param", z.object({ thread_id: z.string().uuid() })),
  zValidator(
    "json",
    z.object({
      subgraphs: schemas.coercedBoolean.optional(),
      checkpoint: schemas.CheckpointSchema.nullish(),
    }),
  ),
  async (c) => {
    // Get Thread State At Checkpoint Post
    const { thread_id } = c.req.valid("param");
    const { checkpoint, subgraphs } = c.req.valid("json");

    const state = stateSnapshotToThreadState(
      await Threads.State.get(
        { configurable: { thread_id, ...checkpoint } },
        { subgraphs },
      ),
    );

    return jsonExtra(c, state);
  },
);

api.get(
  "/threads/:thread_id/history",
  zValidator("param", z.object({ thread_id: z.string().uuid() })),
  zValidator(
    "query",
    z.object({
      limit: z
        .string()
        .optional()
        .default("10")
        .transform((value) => parseInt(value, 10)),
      before: z.string().optional(),
    }),
  ),
  async (c) => {
    // Get Thread History
    const { thread_id } = c.req.valid("param");
    const { limit, before } = c.req.valid("query");

    const states = await Threads.State.list(
      { configurable: { thread_id, checkpoint_ns: "" } },
      { limit, before },
    );
    return jsonExtra(c, states.map(stateSnapshotToThreadState));
  },
);

api.post(
  "/threads/state/batch",
  zValidator(
    "json",
    z.object({
      supersteps: z
        .array(
          z.object({
            updates: z.array(
              z.object({
                values: z.unknown().nullish(),
                command: schemas.CommandSchema.nullish(),
                as_node: z.string(),
              }),
            ),
          }),
        )
        .describe("The supersteps to apply to the thread."),
      thread_id: z
        .string()
        .uuid()
        .describe("The ID of the thread. If not provided, an ID is generated.")
        .optional(),
      metadata: z
        .object({})
        .catchall(z.any())
        .describe("Metadata for the thread.")
        .optional(),
      if_exists: z
        .union([z.literal("raise"), z.literal("do_nothing")])
        .optional(),
    }),
  ),
  async (c) => {
    // Create a new thread from a batch of state updates
    const payload = c.req.valid("json");
    const newThread = await Threads.put(payload.thread_id || uuid4(), {
      metadata: payload.metadata,
      if_exists: payload.if_exists ?? "raise",
    });

    await Threads.State.batch(
      { configurable: { thread_id: newThread.thread_id } },
      payload.supersteps,
    );
    return jsonExtra(c, newThread);
  },
);

api.post(
  "/threads/:thread_id/history",
  zValidator("param", z.object({ thread_id: z.string().uuid() })),
  zValidator(
    "json",
    z.object({
      limit: z.number().optional().default(10),
      before: z.string().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
      checkpoint: z
        .object({
          checkpoint_id: z.string().uuid().optional(),
          checkpoint_ns: z.string().optional(),
          checkpoint_map: z.record(z.string(), z.unknown()).optional(),
        })
        .optional(),
    }),
  ),
  async (c) => {
    // Get Thread History Post
    const { thread_id } = c.req.valid("param");
    const { limit, before, metadata, checkpoint } = c.req.valid("json");

    const states = await Threads.State.list(
      { configurable: { thread_id, checkpoint_ns: "", ...checkpoint } },
      { limit, before, metadata },
    );

    return jsonExtra(c, states.map(stateSnapshotToThreadState));
  },
);

api.get(
  "/threads/:thread_id",
  zValidator("param", z.object({ thread_id: z.string().uuid() })),
  async (c) => {
    // Get Thread
    const { thread_id } = c.req.valid("param");
    return jsonExtra(c, await Threads.get(thread_id));
  },
);

api.delete(
  "/threads/:thread_id",
  zValidator("param", z.object({ thread_id: z.string().uuid() })),
  async (c) => {
    // Delete Thread
    const { thread_id } = c.req.valid("param");
    await Threads.delete(thread_id);
    return new Response(null, { status: 204 });
  },
);

api.patch(
  "/threads/:thread_id",
  zValidator("param", z.object({ thread_id: z.string().uuid() })),
  zValidator("json", z.object({ metadata: z.record(z.string(), z.unknown()) })),
  async (c) => {
    // Patch Thread
    const { thread_id } = c.req.valid("param");
    const { metadata } = c.req.valid("json");
    return jsonExtra(c, await Threads.patch(thread_id, { metadata }));
  },
);

api.post(
  "/threads/:thread_id/copy",
  zValidator("param", z.object({ thread_id: z.string().uuid() })),
  async (c) => {
    // Copy Thread
    const { thread_id } = c.req.valid("param");
    return jsonExtra(c, await Threads.copy(thread_id));
  },
);

export default api;
