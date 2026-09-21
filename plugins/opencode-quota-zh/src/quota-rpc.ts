import { Rpc } from "@opencode/plugin"
import { z } from "zod"

export const quotaRpc = Rpc.define({
  id: "opencode-quota-zh",
  methods: {
    snapshot: {
      input: z.object({}),
      output: z.object({
        lines: z.array(z.string()),
        providerCount: z.number().int().nonnegative(),
      }),
    },
  },
  events: {},
})
