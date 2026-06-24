// GenerationGate — priority-queue mutex shared between the foreground chat SSE
// handler and the background agent runner. Foreground ('fg') requests jump ahead
// of queued background ('bg') callers so the user's chat always feels snappy.
// Acquired once per engine call; released before tool execution.

interface Waiter {
  priority: 'fg' | 'bg'
  resolve: (release: () => void) => void
}

export class GenerationGate {
  private held = false
  private queue: Waiter[] = []

  async acquire(priority: 'fg' | 'bg'): Promise<() => void> {
    if (!this.held) {
      this.held = true
      return this.makeRelease()
    }
    return new Promise<() => void>((resolve) => {
      const waiter: Waiter = { priority, resolve }
      if (priority === 'fg') {
        // fg jumps ahead of all bg waiters
        const firstBg = this.queue.findIndex((w) => w.priority === 'bg')
        this.queue.splice(firstBg >= 0 ? firstBg : this.queue.length, 0, waiter)
      } else {
        this.queue.push(waiter)
      }
    })
  }

  private makeRelease(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.queue.shift()
      if (next) next.resolve(this.makeRelease())
      else this.held = false
    }
  }
}
