import { useId, useRef, useState } from 'react'
import type { CodexPermission } from '../types'
import { act, loadCodexPermissions } from '../store'

export function CodexQuestionCard({ taskId, permission }: { taskId: string; permission: CodexPermission }) {
  const formId = useId()
  const questions = permission.questions ?? []
  const [values, setValues] = useState<Record<string, { choice?: number; text?: string }>>({})
  const [busy, setBusy] = useState(false)
  const sending = useRef(false)
  const answer = (id: string, patch: { choice?: number; text?: string }) => setValues(current => ({ ...current, [id]: { ...current[id], ...patch } }))
  const answers = Object.fromEntries(questions.map(question => {
    const value = values[question.id]
    const text = value?.choice === undefined || value.choice < 0 ? value?.text ?? '' : question.options?.[value.choice]?.label ?? ''
    return [question.id, { answers: [text] }]
  }))
  const complete = questions.length > 0 && Object.values(answers).every(value => value.answers[0].trim())
  const submit = async (skip = false) => {
    if (sending.current || (!skip && !complete)) return
    sending.current = true
    setBusy(true)
    try {
      const result = await act('codex.task.answer', { taskId, requestId: permission.requestId, answers: skip ? {} : answers })
      if (result) { setValues({}); await loadCodexPermissions(taskId) }
    } finally { sending.current = false; setBusy(false) }
  }
  return <form className="approval-card codex-question-card" aria-label="Codex からの質問" onKeyDown={event => {
    if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault()
  }} onSubmit={event => { event.preventDefault(); void submit() }}>
    <div className="approval-head">{permission.title}</div>
    {questions.map((question, index) => <fieldset key={question.id} disabled={busy}>
      <legend>{question.header}</legend>
      <p>{question.question}</p>
      {question.options?.map((option, optionIndex) => <label className="codex-question-option" key={optionIndex}>
        <input type="radio" name={`${formId}-${index}`} checked={values[question.id]?.choice === optionIndex} onChange={() => answer(question.id, { choice: optionIndex })} />
        <span>{option.label}{option.description && <small>{option.description}</small>}</span>
      </label>)}
      {(question.isOther || !question.options?.length) && <label className="codex-question-option">
        {Boolean(question.options?.length) && <input type="radio" name={`${formId}-${index}`} checked={values[question.id]?.choice === -1} onChange={() => answer(question.id, { choice: -1 })} />}
        <span>{question.options?.length ? 'その他（自由記述）' : '回答'}
          <input type={question.isSecret ? 'password' : 'text'} aria-label={`${question.header}の回答`} autoComplete="off" value={values[question.id]?.text ?? ''} onFocus={() => answer(question.id, { choice: -1 })} onChange={event => answer(question.id, { choice: -1, text: event.target.value })} />
        </span>
      </label>}
    </fieldset>)}
    <div className="approval-actions">
      <button type="button" className="button" disabled={busy} onClick={() => void submit(true)}>スキップ</button>
      <button type="submit" className="button primary" disabled={busy || !complete}>{busy ? '送信中…' : '回答を送信'}</button>
    </div>
  </form>
}
