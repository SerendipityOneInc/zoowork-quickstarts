import { useEffect, useRef, useState } from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { useMe } from './hooks/useMe.ts'
import { useSessions } from './hooks/useSessions.ts'
import { useConversation } from './hooks/useConversation.ts'
import { useSendMessage } from './hooks/useSendMessage.ts'
import { useAnswer } from './hooks/useAnswer.ts'
import { debugAtom, navOpenAtom, newSessionAtom, openSessionAtom, taskIdAtom, themeAtom } from './store/ui.ts'
import { busyTasksAtom } from './store/conversation.ts'
import { ChatPanel } from './components/ChatPanel.tsx'
import { Composer } from './components/Composer.tsx'
import { Sidebar } from './components/Sidebar.tsx'
// The right-hand pane is the business seam. By default it's the four-tab agent panel
// (Agent / Config / Runtime / Debug); replace it in domain/view.tsx with your domain cards.
import { Bench } from '../domain/view.tsx'

// Brand shown in the sidebar (and the mobile bar). A vertical sets its own.
const BRAND = 'Zooclaw App Kit'
const TAG = 'starter'

export function App() {
  const me = useMe()
  const email = me.data?.email ?? ''
  const sessionsQ = useSessions(!me.isError)
  const sessions = sessionsQ.data ?? []

  const taskId = useAtomValue(taskIdAtom)
  const busyTasks = useAtomValue(busyTasksAtom)
  const newSession = useSetAtom(newSessionAtom)
  const openSession = useSetAtom(openSessionAtom)
  const { view, busy, prompts } = useConversation()
  const send = useSendMessage()
  const answer = useAnswer()

  const [theme, setTheme] = useAtom(themeAtom)
  const [navOpen, setNavOpen] = useAtom(navOpenAtom)
  const [pane, setPane] = useState<'chat' | 'bench'>('chat') // mobile: which pane is visible

  // Debug pane visibility (right-hand bench). Template default is ON. Tap the brand 5× quickly to
  // TOGGLE it — hide the debug pane to preview the clean product view, tap 5× again to bring it
  // back. (To ship clean by default instead, flip debugAtom's initial value to false.)
  const [debug, setDebug] = useAtom(debugAtom)
  const brandTaps = useRef(0)
  const lastTap = useRef(0)
  const tapBrand = () => {
    const now = Date.now()
    brandTaps.current = now - lastTap.current < 600 ? brandTaps.current + 1 : 1
    lastTap.current = now
    if (brandTaps.current >= 5) {
      brandTaps.current = 0
      setDebug((d) => !d)
    }
  }

  // Theme: reflect light/dark on <html> (persistence is handled by the atom).
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
  }, [theme])

  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))

  return (
    <div className="app">
      {/* Desktop has no header — the brand/new/theme controls live in the sidebar. This slim
          bar only shows on mobile, where the sidebar collapses into a drawer. */}
      <div className="mobilebar">
        <button className="hamburger" onClick={() => setNavOpen(true)} aria-label="Sessions">☰</button>
        <span className="brand" onClick={tapBrand}>{BRAND}</span>
        {debug && (
          <div className="pane-toggle">
            <button className={pane === 'chat' ? 'active' : ''} onClick={() => setPane('chat')}>Chat</button>
            <button className={pane === 'bench' ? 'active' : ''} onClick={() => setPane('bench')}>Panel</button>
          </div>
        )}
      </div>
      <div className="workspace">
        <Sidebar
          brand={BRAND}
          tag={TAG}
          email={email}
          sessions={sessions}
          currentId={taskId}
          busyIds={busyTasks}
          onSelect={openSession}
          onNew={() => newSession()}
          open={navOpen}
          onClose={() => setNavOpen(false)}
          theme={theme}
          onToggleTheme={toggleTheme}
          onTapBrand={tapBrand}
        />
        <div className={`split pane-${pane}${debug ? ' with-bench' : ''}`}>
          <section className="left">
            <ChatPanel chat={view} busy={busy} onAnswer={answer} />
            <Composer onSend={send} busy={busy} />
          </section>
          {debug && (
            <section className="right">
              <Bench prompts={prompts} />
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
