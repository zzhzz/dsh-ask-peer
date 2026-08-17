/**
 * The replayable ask event family. The host appends these to the owner's
 * session log; the Web client's conversation-node engine folds them into the
 * ask bubbles (pending → running → answered / declined).
 */

/** Opens one ask approval: emitted when an inbound ask is held for the owner. */
export interface AskRequestData {
  /** Stable ask id shared by every event in the family. */
  askId: string
  /** The caller's peer name. */
  caller: string
  /** The question text. */
  question: string
  /** Optional workspace-relative context files the answering agent should read. */
  contextFiles?: string[]
  /** One-time decision token; only the ask/request event carries it. */
  decisionToken: string
  /** Where the browser posts the approve/decline decision. */
  decisionUrl: string
}

/** Records the owner's decision for one ask. */
export interface AskDecisionData {
  askId: string
  caller: string
  decision: 'approved' | 'declined'
}

/** Closes one ask with the answering agent's committed text. */
export interface AskResultData {
  askId: string
  caller: string
  answer: string
  truncated: boolean
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * An inbound ask is waiting for the owner's decision.
     * @mode emit
     * @param data - stable ask id, caller, question, and the one-time decision channel.
     */
    'ask/request': AskRequestData
    /**
     * The owner approved or declined one ask.
     * @mode emit
     * @param data - stable ask id and the decision.
     */
    'ask/decision': AskDecisionData
    /**
     * The answering agent finished and the ask is answered.
     * @mode emit
     * @param data - stable ask id and the committed answer.
     */
    'ask/result': AskResultData
  }
}
