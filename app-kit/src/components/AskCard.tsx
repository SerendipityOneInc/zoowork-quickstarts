import { useState, type Dispatch, type SetStateAction } from 'react'
import type { Ask } from '../chat.ts'
import { Markdown } from './Markdown.tsx'

/** A `{ type: 'form', fields: [...] }` UI payload the agent can attach to an ask_user_question via
 *  the tool's `input` field. Parsed leniently — anything that isn't a well-formed form
 *  falls back to the option/free-text card. */
type AskFormField = { name: string; label?: string; type: string; placeholder?: string; options: string[] }
type AskFormInput = { title?: string; submitLabel?: string; fields: AskFormField[] }

function asFormInput(input: unknown): AskFormInput | null {
  if (!input || typeof input !== 'object') return null
  const v = input as Record<string, unknown>
  if (v.type !== 'form' || !Array.isArray(v.fields)) return null
  const fields = v.fields.flatMap((f): AskFormField[] => {
    if (!f || typeof f !== 'object') return []
    const r = f as Record<string, unknown>
    if (typeof r.name !== 'string' || !r.name) return []
    return [
      {
        name: r.name,
        label: typeof r.label === 'string' ? r.label : undefined,
        type: typeof r.type === 'string' ? r.type : 'text',
        placeholder: typeof r.placeholder === 'string' ? r.placeholder : undefined,
        options: Array.isArray(r.options) ? r.options.filter((o): o is string => typeof o === 'string') : [],
      },
    ]
  })
  if (fields.length === 0) return null
  return {
    title: typeof v.title === 'string' ? v.title : undefined,
    submitLabel: typeof v.submitLabel === 'string' ? v.submitLabel : undefined,
    fields,
  }
}

/**
 * AskCard — renders a blocked `ask_user_question` and submits the answer that resumes the turn.
 * Three shapes the agent can ask, all answered as one arbitrary-JSON `answer` (the worker + Zooclaw
 * treat it opaquely — see useAnswer): a single-select (submit on click → `{ selectedOptions: [i] }`),
 * a multi-select (toggle then Send → `{ selectedOptions, customResponse? }`), or a `{ type: 'form' }`
 * input (fields → `{ values }`). A free-text box is always offered alongside options as the universal
 * fallback, so a question with no options is never a dead end.
 *
 * `done` (answered by a later reply, or already submitted this session) renders the card inert.
 */
export function AskCard({ ask, done, onSubmit }: { ask: Ask; done: boolean; onSubmit: (answer: unknown) => void }) {
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<number[]>([]) // multi-select picks
  const [choice, setChoice] = useState<number | null>(null) // single-select highlight
  const [custom, setCustom] = useState('')
  const [values, setValues] = useState<Record<string, unknown>>({})

  const form = asFormInput(ask.input)
  const multi = ask.multiSelect === true
  const disabled = done || busy

  const submit = (answer: unknown) => {
    if (disabled) return
    setBusy(true)
    onSubmit(answer)
  }

  const onOption = (i: number) => {
    if (disabled) return
    if (multi) {
      setSelected((prev) => (prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i]))
      return
    }
    setChoice(i)
    submit({ selectedOptions: [i] }) // single-select submits immediately
  }

  const sendMulti = () => submit({ selectedOptions: selected, ...(custom.trim() ? { customResponse: custom.trim() } : {}) })
  const sendCustom = () => { if (custom.trim()) submit({ selectedOptions: [], customResponse: custom.trim() }) }
  const submitForm = () => {
    if (!form) return
    const v = Object.fromEntries(form.fields.map((f) => [f.name, values[f.name] ?? (f.type === 'toggle' ? false : '')]))
    submit({ values: v })
  }

  if (form) {
    return (
      <div className="bubble assistant ask">
        <div className="ask-q"><Markdown text={ask.question} /></div>
        {form.title ? <div className="ask-form-title">{form.title}</div> : null}
        <div className="ask-form">
          {form.fields.map((f) => (
            <label key={f.name} className="ask-field">
              <span className="ask-field-label">{f.label ?? f.name}</span>
              <FieldInput field={f} values={values} setValues={setValues} disabled={disabled} />
            </label>
          ))}
        </div>
        <button className="ask-send" disabled={disabled} onClick={submitForm}>{form.submitLabel ?? 'Submit'}</button>
      </div>
    )
  }

  const canSend = multi ? selected.length > 0 || custom.trim().length > 0 : custom.trim().length > 0
  return (
    <div className="bubble assistant ask">
      <div className="ask-q"><Markdown text={ask.question} /></div>
      {ask.options.length > 0 ? (
        <div className="ask-options">
          {ask.options.map((opt, i) => {
            const on = multi ? selected.includes(i) : choice === i
            return (
              <button
                key={i}
                className={`ask-option${on ? ' chosen' : ''}${opt.description ? ' rich' : ''}`}
                disabled={disabled}
                onClick={() => onOption(i)}
              >
                <span className="ask-option-label">{opt.label}</span>
                {opt.description ? <span className="ask-desc">{opt.description}</span> : null}
              </button>
            )
          })}
        </div>
      ) : null}
      <div className="ask-custom">
        <input
          type="text"
          className="ask-input"
          value={custom}
          disabled={disabled}
          placeholder={ask.options.length ? 'Or type your own...' : 'Type your answer...'}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') multi ? sendMulti() : sendCustom() }}
        />
        <button className="ask-send" disabled={disabled || !canSend} onClick={multi ? sendMulti : sendCustom}>Send</button>
      </div>
    </div>
  )
}

/** One form field by `type` (text · number · textarea · select · toggle); unknown types fall to a
 *  text input. */
function FieldInput({
  field,
  values,
  setValues,
  disabled,
}: {
  field: AskFormField
  values: Record<string, unknown>
  setValues: Dispatch<SetStateAction<Record<string, unknown>>>
  disabled: boolean
}) {
  const set = (value: unknown) => setValues((prev) => ({ ...prev, [field.name]: value }))
  if (field.type === 'textarea') {
    return (
      <textarea
        className="ask-input ask-textarea"
        disabled={disabled}
        placeholder={field.placeholder}
        value={String(values[field.name] ?? '')}
        onChange={(e) => set(e.target.value)}
      />
    )
  }
  if (field.type === 'select' && field.options.length > 0) {
    return (
      <select className="ask-input" disabled={disabled} value={String(values[field.name] ?? '')} onChange={(e) => set(e.target.value)}>
        <option value="">{field.placeholder ?? 'Select...'}</option>
        {field.options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    )
  }
  if (field.type === 'toggle') {
    return (
      <input
        type="checkbox"
        className="ask-toggle"
        disabled={disabled}
        checked={Boolean(values[field.name])}
        onChange={(e) => set(e.target.checked)}
      />
    )
  }
  return (
    <input
      type={field.type === 'number' ? 'number' : 'text'}
      className="ask-input"
      disabled={disabled}
      placeholder={field.placeholder}
      value={String(values[field.name] ?? '')}
      onChange={(e) => set(field.type === 'number' ? Number(e.target.value) : e.target.value)}
    />
  )
}
