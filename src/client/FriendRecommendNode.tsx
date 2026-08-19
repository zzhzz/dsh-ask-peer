import { useState } from 'react'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { FriendRecommendChatData } from './index.ts'
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
  reason: { color: themeTokens.muted, fontSize: 12, marginBottom: 6 },
  detail: { display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 6 },
  description: { fontSize: 13 },
  tags: { color: themeTokens.muted, fontSize: 12 },
  mono: { fontFamily: 'monospace', fontSize: 12, color: themeTokens.textSecondary, wordBreak: 'break-all' },
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
  muted: { color: themeTokens.muted, fontSize: 12 },
}

/** A short, human-readable form of the public sign, mirroring host-side shortSign. */
function shortFingerprint(publicSign: string): string {
  return publicSign.startsWith('ed25519:') ? publicSign.slice(0, 23) : publicSign.slice(0, 16)
}

/**
 * Render one friend recommendation as a chat bubble: the recommended agent's
 * detail card (name, host:port, description, tags, sign fingerprint) with
 * Add/Decline actions; later states show the outcome.
 */
export function FriendRecommendNodeView({ node, t: _t }: ChatNodeViewProps<'friend-recommend'>) {
  const [busy, setBusy] = useState(false)
  const data = node.data
  const peer = data.peer

  const decide = async (decision: 'add' | 'decline'): Promise<void> => {
    if (busy || data.decisionUrl === undefined || data.decisionToken === undefined) return
    setBusy(true)
    try {
      await fetch(data.decisionUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ recId: data.recId, token: data.decisionToken, decision }),
      })
    } catch {
      // The recommendation expires on its own; the next poll drops it.
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={styles.card} data-friend-status={data.status}>
      <div style={styles.header}>
        {data.via !== undefined && data.via.length > 0
          ? `${peer.name} recommended via ${data.via.join(' → ')}`
          : `${data.from} recommends ${peer.name}`}
      </div>
      {data.reason !== undefined ? <div style={styles.reason}>Asked about: {data.reason}</div> : null}
      <div style={styles.detail}>
        {peer.description !== undefined && peer.description !== '' ? (
          <div style={styles.description}>{peer.description}</div>
        ) : null}
        {peer.tags !== undefined && peer.tags.length > 0 ? (
          <div style={styles.tags}>Tags: {peer.tags.join(', ')}</div>
        ) : null}
        <div style={styles.mono}>
          {peer.host}:{peer.port}
        </div>
        <div style={styles.mono}>sign {shortFingerprint(peer.publicKey)}</div>
      </div>

      {data.status === 'pending' ? (
        <div style={styles.actions}>
          <button
            type="button"
            style={{ ...styles.button, ...styles.buttonPrimary }}
            disabled={busy}
            onClick={() => void decide('add')}
          >
            Add friend
          </button>
          <button type="button" style={styles.button} disabled={busy} onClick={() => void decide('decline')}>
            Decline
          </button>
        </div>
      ) : null}
      {data.status === 'added' ? <div style={styles.muted}>Added {peer.name} to friends</div> : null}
      {data.status === 'declined' ? <div style={styles.muted}>Declined</div> : null}
    </div>
  )
}
