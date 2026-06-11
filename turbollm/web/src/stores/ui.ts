import { create } from 'zustand'

export type Theme = 'system' | 'light' | 'dark'

const THEME_KEY = 'tllm.theme'

function readStoredTheme(): Theme {
  const v = localStorage.getItem(THEME_KEY)
  return v === 'light' || v === 'dark' || v === 'system' ? v : 'system'
}

/** Resolve the effective light/dark mode for a theme value, honoring system. */
export function resolveDark(theme: Theme): boolean {
  if (theme === 'dark') return true
  if (theme === 'light') return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

/** Apply or remove the `.dark` class on <html>. */
export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', resolveDark(theme))
}

type UiState = {
  theme: Theme
  setTheme: (theme: Theme) => void
  sidebarCollapsed: boolean
  toggleSidebar: () => void
  logPanelOpen: boolean
  setLogPanelOpen: (open: boolean) => void
}

export const useUiStore = create<UiState>((set) => ({
  theme: readStoredTheme(),
  setTheme: (theme) => {
    localStorage.setItem(THEME_KEY, theme)
    applyTheme(theme)
    set({ theme })
  },
  sidebarCollapsed: false,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  logPanelOpen: false,
  setLogPanelOpen: (logPanelOpen) => set({ logPanelOpen }),
}))
