import { useEffect, useState } from 'react'
import type { PendingAskView, PendingRecommendView } from '../protocol.ts'
import { themeTokens } from './theme.ts'

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
    background: themeTokens.blockBg,
    border: `1px solid ${themeTokens.border}`,
    borderRadius: 10,
    padding: '10px 12px',
    boxShadow: '0 4px 14px rgba(0,0,0,.14)',
    color: themeTokens.text,
  },
  header: { fontWeight: 600, marginBottom: 4 },
  question: { whiteSpace: 'pre-wrap', marginBottom: 8, fontSize: 13 },
  detail: { display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 8, fontSize: 12 },
  mono: { fontFamily: 'monospace', fontSize: 11, color: themeTokens.textSecondary, wordBreak: 'break-all' },
  actions: { display: 'flex', gap: 8 },
  button: {
    padding: '4px 12px',
    borderRadius: 6,
    border: `1px solid ${themeTokens.borderInput}`,
    background: themeTokens.buttonBg,
    color: themeTokens.text,
    cursor: 'pointer',
  },
  primary: {
    background: themeTokens.primaryBg,
    borderColor: themeTokens.primaryBg,
    color: themeTokens.primaryText,
  },
}

/**
 * Session-independent notification: polls the host for pending asks and shows
 * an Answer/Decline toast over any page, so the owner approves asks without
 * opening a particular session.
 */
export function AskNotify() {
  const [asks, setAsks] = useState<PendingAskView[]>([])
  const [friends, setFriends] = useState<PendingRecommendView[]>([])

  useEffect(() => {
    let alive = true
    const poll = async (): Promise<void> => {
      try {
        const response = await fetch('/ask-peer/pending')
        if (response.ok) {
          const list = (await response.json()) as PendingAskView[]
          if (alive) setAsks(list)
        }
        const friendResponse = await fetch('/ask-peer/pending-friends')
        if (friendResponse.ok) {
          const list = (await friendResponse.json()) as PendingRecommendView[]
          if (alive) setFriends(list)
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

  const decideFriend = async (rec: PendingRecommendView, decision: 'add' | 'decline'): Promise<void> => {
    try {
      await fetch(rec.decisionUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ recId: rec.recId, token: rec.decisionToken, decision }),
      })
      setFriends((current) => current.filter((item) => item.recId !== rec.recId))
    } catch {
      // The recommendation expires on its own; the next poll drops it.
    }
  }

  if (asks.length === 0 && friends.length === 0) return null
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
      {friends.map((rec) => (
        <div key={rec.recId} style={styles.card}>
          <div style={styles.header}>
            {rec.from} recommends {rec.peer.name}
          </div>
          {rec.reason !== undefined ? (
            <div style={styles.question}>Asked about: {rec.reason}</div>
          ) : null}
          <div style={styles.detail}>
            {rec.peer.description !== undefined && rec.peer.description !== '' ? (
              <div>{rec.peer.description}</div>
            ) : null}
            {rec.peer.tags !== undefined && rec.peer.tags.length > 0 ? (
              <div>Tags: {rec.peer.tags.join(', ')}</div>
            ) : null}
            <div style={styles.mono}>
              {rec.peer.host}:{rec.peer.port}
            </div>
          </div>
          <div style={styles.actions}>
            <button
              type="button"
              style={{ ...styles.button, ...styles.primary }}
              onClick={() => void decideFriend(rec, 'add')}
            >
              Add friend
            </button>
            <button type="button" style={styles.button} onClick={() => void decideFriend(rec, 'decline')}>
              Decline
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
