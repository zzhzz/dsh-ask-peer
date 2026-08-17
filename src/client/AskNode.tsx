import { useState } from 'react'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { AskChatData } from './index.ts'
import { themeTokens } from './theme.ts'

const styles: Record<string, React.CSSProperties> = {
  card: {
    border: `1px solid ${themeTokens.border}`,
    borderRadius: '10px',
    padding: '10px 12px',
    margin: '4px 0',
    maxWidth: '560px',
    background: themeTokens.blockBg,
    color: themeTokens.text,
  },
  header: { fontWeight: 600, marginBottom: 4 },
  question: { whiteSpace: 'pre-wrap', marginBottom: 6 },
  files: { color: themeTokens.muted, fontSize: 12, marginBottom: 6 },
  answer: { whiteSpace: 'pre-wrap', marginBottom: 4 },
  actions: { display: 'flex', gap: 8, marginTop: 8 },
  button: {
    padding: '4px 12px',
    borderRadius: 6,
    border: `1px solid ${themeTokens.borderInput}`,
    background: themeTokens.buttonBg,
    color: themeTokens.text,
    cursor: 'pointer',
  },
  buttonPrimary: {
    background: themeTokens.primaryBg,
    borderColor: themeTokens.primaryBg,
    color: themeTokens.primaryText,
  },
  muted: { color: themeTokens.muted },
}

/**
 * Render one ask as a chat bubble: pending shows the question and
 * approve/decline actions; later states show progress or the answer.
 */
export function AskNodeView({ node, t: _t }: ChatNodeViewProps<'ask'>) {
  const [busy, setBusy] = useState(false)
  const data = node.data

  const decide = async (decision: 'approve' | 'decline'): Promise<void> => {
    if (busy || data.decisionUrl === undefined || data.decisionToken === undefined) return
    setBusy(true)
    try {
      await fetch(data.decisionUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ askId: data.askId, token: data.decisionToken, decision }),
      })
    } catch {
      // The host fails the ask closed on its own timeout.
    } finally {
      setBusy(false)
    }
  }

  const files =
    data.contextFiles !== undefined && data.contextFiles.length > 0
      ? `Context files: ${data.contextFiles.join(', ')}`
      : null

  return (
    <div style={styles.card} data-ask-status={data.status}>
      <div style={styles.header}>{data.caller} asks your agent</div>
      <div style={styles.question}>{data.question}</div>
      {files !== null ? <div style={styles.files}>{files}</div> : null}

      {data.status === 'pending' ? (
        <div style={styles.actions}>
          <button
            type="button"
            style={{ ...styles.button, ...styles.buttonPrimary }}
            disabled={busy}
            onClick={() => void decide('approve')}
          >
            Answer
          </button>
          <button type="button" style={styles.button} disabled={busy} onClick={() => void decide('decline')}>
            Decline
          </button>
        </div>
      ) : null}

      {data.status === 'running' ? <div style={styles.muted}>Answering…</div> : null}
      {data.status === 'answered' ? (
        <div style={styles.answer}>
          {data.answer}
          {data.truncated === true ? ' (truncated)' : ''}
        </div>
      ) : null}
      {data.status === 'declined' ? <div style={styles.muted}>Declined</div> : null}
    </div>
  )
}
