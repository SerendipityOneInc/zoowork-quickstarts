import { Fragment, useEffect, useRef, useState } from 'react'
import type { Ask, ChatBubble } from '../chat.ts'
import { Markdown } from './Markdown.tsx'
import { Lightbox } from './Lightbox.tsx'
import { FileCard } from './FileCard.tsx'
import { AskCard } from './AskCard.tsx'

export function ChatPanel({
  chat,
  busy,
  onAnswer,
}: {
  chat: ChatBubble[]
  busy: boolean
  /** Submit the user's answer for a blocked ask_user_question — an arbitrary JSON value (option
   *  pick / multi-select / free-text / form values; AskCard builds it). */
  onAnswer?: (ask: Ask, answer: unknown) => void
}) {
  const endRef = useRef<HTMLDivElement>(null)
  const [lightbox, setLightbox] = useState<string | null>(null)
  // Optimistic per-question "submitted" set: the moment an answer is sent, render that card inert
  // (and let the typing indicator return) before the resumed turn's reply flips `ask.answered`.
  const [submitted, setSubmitted] = useState<Record<number, boolean>>({})
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [chat.length, busy])

  // The one text-bubble shape (assistant text renders markdown; user/error render raw). Keyed so it
  // can be the top-level element of a plain turn or a child of an attachment Fragment.
  const textBubble = (b: ChatBubble) => (
    <div key={b.key} className={`bubble ${b.role}${b.error ? ' error' : ''}`}>
      {b.role === 'assistant' && !b.error ? <Markdown text={b.text} /> : b.text}
    </div>
  )

  const renderBubble = (b: ChatBubble) => {
    // ask_user_question card: the agent paused for a decision. AskCard renders the right affordance
    // (options / multi-select / free-text / form) and hands back the answer JSON; submitting resumes
    // the turn on the same stream. Mark it submitted so the card goes inert immediately.
    if (b.ask) {
      const a = b.ask
      return (
        <AskCard
          key={b.key}
          ask={a}
          done={a.answered || !!submitted[a.actionId]}
          onSubmit={(answer) => {
            setSubmitted((prev) => ({ ...prev, [a.actionId]: true }))
            onAnswer?.(a, answer)
          }}
        />
      )
    }
    // Image attachments render STANDALONE (not inside the accent bubble), aligned with the sender;
    // the text bubble (if any) follows below — ChatGPT-style.
    if (b.attachments?.length) {
      return (
        <Fragment key={b.key}>
          <div className={`msg-attachments ${b.role}`}>
            {b.attachments.map((a) =>
              a.contentType.startsWith('image/') ? (
                <img
                  key={a.fileId}
                  className="msg-thumb"
                  src={a.thumbUrl}
                  alt={a.filename}
                  loading="lazy"
                  onClick={() => setLightbox(a.largeUrl)}
                />
              ) : (
                <FileCard key={a.fileId} filename={a.filename} contentType={a.contentType} />
              ),
            )}
          </div>
          {b.text ? textBubble(b) : null}
        </Fragment>
      )
    }
    return textBubble(b)
  }

  // When the turn is paused on an unanswered question, the agent is waiting on the USER, not
  // working - so suppress the "Working..." indicator until the choice is made.
  const last = chat[chat.length - 1]
  const pendingAsk = !!last?.ask && !last.ask.answered && !submitted[last.ask.actionId]

  return (
    <div className="chat">
      {chat.length === 0 ? (
        <div className="chat-welcome">
          <h1>Zooclaw App Kit</h1>
          <p className="muted">agent-native starter</p>
          <p>Send a message to start. The <em>Panel</em> on the right is a debug view: every raw frame, as it arrives.</p>
        </div>
      ) : (
        chat.map(renderBubble)
      )}
      {busy && !pendingAsk ? <div className="bubble assistant typing">Working...</div> : null}
      <div ref={endRef} />
      {lightbox && <Lightbox src={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  )
}
