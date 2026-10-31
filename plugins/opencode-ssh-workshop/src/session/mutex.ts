import type { SessionState } from "./state.js"

/**
 * 保证同一条 SSH 连接上一次只跑一条命令；后续调用排队依次执行。
 * 与上游 v0.3.0 逐行一致。
 */
export async function withMutex<T>(state: SessionState, fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = async () => {
      state.running = true
      try {
        resolve(await fn())
      } catch (e) {
        reject(e)
      } finally {
        state.running = false
        const next = state.commandQueue.shift()
        if (next) next()
      }
    }

    if (state.running) {
      state.commandQueue.push(run)
    } else {
      run()
    }
  })
}
