import { Toaster as SonnerToaster } from 'sonner'
import { resolveDark, useUiStore } from '../../stores/ui'

/** App toaster wired to the active theme. Tokens applied in index.css. */
export function Toaster() {
  const theme = useUiStore((s) => s.theme)
  const mode = resolveDark(theme) ? 'dark' : 'light'
  return <SonnerToaster theme={mode} position="bottom-right" closeButton />
}

export { toast } from 'sonner'
