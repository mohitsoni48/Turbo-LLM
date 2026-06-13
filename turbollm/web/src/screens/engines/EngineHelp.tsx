import { useState } from 'react'
import { ChevronDown, HelpCircle } from 'lucide-react'

/** Collapsible explainer teaching the two-level Engine → Build model. Open by
 *  default the first time; the choice is remembered in localStorage. */
export function EngineHelp() {
  const [open, setOpen] = useState(() => localStorage.getItem('tllm.engineHelpClosed') !== '1')

  const toggle = () => {
    setOpen((o) => {
      localStorage.setItem('tllm.engineHelpClosed', o ? '1' : '0')
      return !o
    })
  }

  return (
    <div className="rounded-lg border border-border bg-panel-2">
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-center gap-2 px-4 py-3 text-left"
      >
        <HelpCircle size={15} className="shrink-0 text-accent" />
        <span className="flex-1 text-[13px] font-medium text-ink">
          How engines &amp; builds work
        </span>
        <ChevronDown
          size={15}
          className={`shrink-0 text-muted transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="border-t border-border px-4 py-3 text-[13px] leading-relaxed text-muted">
          <p className="mb-3">
            Selecting an engine is a <span className="font-medium text-ink">two-step</span> choice:
            pick the <span className="font-medium text-ink">Engine</span>, then its{' '}
            <span className="font-medium text-ink">Build</span>.
          </p>

          <div className="mb-3 flex flex-col gap-2">
            <Level
              n="1"
              title="Engine — the runtime / fork"
              body="The inference project itself. Official llama.cpp is built in; a fork you add (e.g. a TurboQuant build) is its own engine; MLX is another. Different engines can support different features and model formats."
            />
            <Level
              n="2"
              title="Build — which GPU backend"
              body="A specific compiled version of that engine: CUDA, Vulkan, ROCm, Metal, CPU. Features like turbo KV cache are baked into the build at compile time — which is why one engine can have several builds, and you pick which one runs."
            />
          </div>

          <ul className="ml-4 list-disc space-y-1">
            <li>
              <span className="font-medium text-ink">Official</span> is permanent — you download
              and remove its individual builds, but the engine itself stays.
            </li>
            <li>
              Engines you <span className="font-medium text-ink">add yourself</span> (your own
              forks) can be deleted as a whole.
            </li>
            <li>
              Only one build runs at a time. The Build dropdown is hidden when an engine has just
              one build.
            </li>
          </ul>
        </div>
      )}
    </div>
  )
}

function Level({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <div className="flex gap-2.5">
      <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded bg-accent text-[11px] font-bold text-on-accent">
        {n}
      </span>
      <div>
        <div className="text-[13px] font-medium text-ink">{title}</div>
        <div className="text-[12px] text-muted">{body}</div>
      </div>
    </div>
  )
}
