import { useEffect, useRef, useState } from 'react'
import {
  Navigate,
  Route,
  Routes,
} from 'react-router-dom'
import { TooltipProvider } from './components/ui/tooltip'
import { Shell } from './components/Shell'
import { UnreachableOverlay } from './components/UnreachableOverlay'
import { useStatus } from './lib/queries'
import { ChatScreen } from './screens/ChatScreen'
import { ModelsScreen } from './screens/ModelsScreen'
import { EnginesScreen } from './screens/EnginesScreen'
import { SettingsScreen } from './screens/SettingsScreen'

export function App() {
  const statusQ = useStatus()

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
  const unreachable = failCount >= 3
  const version = statusQ.data?.version ? `v${statusQ.data.version}` : 'v0.0.0-dev'

  return (
    <TooltipProvider delayDuration={300}>
      <Shell status={statusQ.data} online={online} version={version}>
        <Routes>
          <Route path="/chat" element={<ChatScreen />} />
          <Route path="/models" element={<ModelsScreen />} />
          <Route path="/engines" element={<EnginesScreen />} />
          <Route path="/settings" element={<SettingsScreen />} />
          <Route path="*" element={<Navigate to="/chat" replace />} />
        </Routes>
      </Shell>
      {unreachable && <UnreachableOverlay />}
    </TooltipProvider>
  )
}
