/**
 * Task tracker — RPC surface.
 *
 * Defines the single `snapshot` method that the TUI calls. The output schema is
 * the wire projection of the domain `Snapshot` type; a compile-time assertion
 * below forces the two to stay mutually assignable, so any drift fails
 * typecheck. Input carries only an optional source selector — never a client
 * directory; the server's own `context.location` is the sole source authority.
 */

import { Rpc } from "@opencode/plugin"
import { z } from "zod"
import type { Snapshot, Source } from "./model.ts"

const sourceSchema = z.enum(["local", "github"])

const taskSchema = z.object({
  id: z.string(),
  title: z.string(),
  sourceState: z.string(),
  terminal: z.boolean(),
  eligible: z.boolean(),
  blockers: z.array(z.string()),
  criteria: z.array(z.string()),
  problem: z.string().optional(),
})

const snapshotSchema = z.object({
  projectKey: z.string(),
  source: sourceSchema,
  sourceKey: z.string(),
  tasks: z.array(taskSchema),
  complete: z.boolean(),
  syncedAt: z.number(),
  suggestedSource: sourceSchema.optional(),
})

// Compile-time guard: the wire schema and the domain types must match exactly.
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never
const _sourceContract: Exact<Source, z.infer<typeof sourceSchema>> = true
const _snapshotContract: Exact<Snapshot, z.infer<typeof snapshotSchema>> = true
void _sourceContract
void _snapshotContract

export const taskRpc = Rpc.define({
  id: "opencode-task-tracker-zh",
  methods: {
    snapshot: {
      // No directory is accepted: the server resolves the source from its own location.
      input: z.object({
        source: sourceSchema.optional(),
      }),
      output: snapshotSchema,
      errors: {
        // A safe, credential-free reason the source could not be read.
        source_unavailable: z.object({ message: z.string() }),
      },
    },
  },
  events: {},
})
