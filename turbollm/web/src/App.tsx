import { useEffect, useRef, useState } from 'react'
import {
  Navigate,
  Route,
  Routes,
} from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { TooltipProvider } from './components/ui/tooltip'
import { Shell } from './components/Shell'
import { UnreachableOverlay } from './components/UnreachableOverlay'
import { AuthGate } from './components/AuthGate'
import { useStatus } from './lib/queries'
import { ApiError, setAuthToken } from './lib/api'
import { ChatScreen } from './screens/ChatScreen'
import { ModelsScreen } from './screens/ModelsScreen'
import { EnginesScreen } from './screens/EnginesScreen'
import { DeveloperScreen } from './screens/DeveloperScreen'
import { CustomizeScreen } from './screens/CustomizeScreen'
import { SettingsScreen } from './screens/SettingsScreen'

export function App() {
  const statusQ = useStatus()
  const qc = useQueryClient()

  // Count consecutive failed polls; show the unreachable overlay after 3 (spec 08 §1).
  const [failCount, setFailCount] = useState(0)
  const lastUpdated = useRef(0)
  useEffect(() => {
    if (statusQ.isSuccess) {
      setFailCount(0)
    } else if (statusQ.isError && statusQ.errorUpdatedAt !== lastUpdated.current) {
      lastUpdated.current = statusQ.errorUpdatedAt
      setFailCount((c) => c + 1)
    }
  }, [statusQ.isSuccess, statusQ.isError, statusQ.dataUpdatedAt, statusQ.errorUpdatedAt])

  const online = statusQ.isSuccess
  // A 401 isn't a lost connection — the daemon is up but (LAN-exposed) wants an API
  // key. Show the key prompt instead of the misleading "lost connection" overlay.
  const needsAuth = statusQ.isError && statusQ.error instanceof ApiError && statusQ.error.status === 401
  const unreachable = !needsAuth && failCount >= 3
  const version = statusQ.data?.version ? `v${statusQ.data.version}` : 'v0.0.0-dev'

  return (
    <TooltipProvider delayDuration={300}>
      <Shell status={statusQ.data} online={online} version={version}>
        <Routes>
          <Route path="/chat" element={<ChatScreen />} />
          <Route path="/chat/:convId" element={<ChatScreen />} />
          <Route path="/models" element={<ModelsScreen />} />
          <Route path="/engines" element={<EnginesScreen />} />
          <Route path="/developer" element={<DeveloperScreen />} />
          <Route path="/customize" element={<CustomizeScreen />} />
          <Route path="/settings" element={<SettingsScreen />} />
          <Route path="*" element={<Navigate to="/chat" replace />} />
        </Routes>
      </Shell>
      {needsAuth && (
        <AuthGate
          onConnect={(key) => {
            setAuthToken(key)
            void qc.invalidateQueries()
          }}
        />
      )}
      {unreachable && <UnreachableOverlay />}
    </TooltipProvider>
  )
}
