import { useEffect, useState } from 'react'
import type { PendingAskView } from '../protocol.ts'

const styles: Record<string, React.CSSProperties> = {
  container: {
    position: 'fixed',
    right: 16,
    bottom: 16,
    zIndex: 9999,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    maxWidth: 380,
  },
  card: {
    background: '#fff',
    border: '1px solid #d8dee6',
    borderRadius: 10,
    padding: '10px 12px',
    boxShadow: '0 4px 14px rgba(0,0,0,.14)',
  },
  header: { fontWeight: 600, marginBottom: 4 },
  question: { whiteSpace: 'pre-wrap', marginBottom: 8, fontSize: 13 },
  actions: { display: 'flex', gap: 8 },
  button: { padding: '4px 12px', borderRadius: 6, border: '1px solid #c3cbd6', background: '#fff', cursor: 'pointer' },
  primary: { background: '#1f6feb', borderColor: '#1f6feb', color: '#fff' },
}

/**
 * Session-independent notification: polls the host for pending asks and shows
 * an Answer/Decline toast over any page, so the owner approves asks without
 * opening a particular session.
 */
export function AskNotify() {
  const [asks, setAsks] = useState<PendingAskView[]>([])

  useEffect(() => {
    let alive = true
    const poll = async (): Promise<void> => {
      try {
        const response = await fetch('/ask-peer/pending')
        if (response.ok) {
          const list = (await response.json()) as PendingAskView[]
          if (alive) setAsks(list)
        }
      } catch {
        // The host may be momentarily unavailable; the next poll retries.
      }
    }
    void poll()
    const timer = setInterval(() => void poll(), 2000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  const decide = async (ask: PendingAskView, decision: 'approve' | 'decline'): Promise<void> => {
    try {
      await fetch(ask.decisionUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ askId: ask.askId, token: ask.decisionToken, decision }),
      })
    } catch {
      // The host fails the ask closed on its own timeout.
    }
  }

  if (asks.length === 0) return null
  return (
    <div style={styles.container}>
      {asks.map((ask) => (
        <div key={ask.askId} style={styles.card}>
          <div style={styles.header}>{ask.caller} asks your agent</div>
          <div style={styles.question}>{ask.question}</div>
          <div style={styles.actions}>
            <button
              type="button"
              style={{ ...styles.button, ...styles.primary }}
              onClick={() => void decide(ask, 'approve')}
            >
              Answer
            </button>
            <button type="button" style={styles.button} onClick={() => void decide(ask, 'decline')}>
              Decline
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
