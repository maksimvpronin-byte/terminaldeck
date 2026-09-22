import { useEffect, useRef, useState } from 'react'
import type { TransferDecisions, TransferPlan } from '../../../shared/types'
import { useT } from '../i18n'

/** A planned transfer waiting on an answer about what it would overwrite. */
export interface PendingTransfer {
  plan: TransferPlan
  /** The host the files come from, when they come from another one. */
  source?: string
  /** The connection this panel was showing when the plan was made. */
  connectionId: string
}

/**
 * Running a planned transfer, for a file panel that is the writing end of it.
 *
 * Planning stays with the panel — it is where the dialogs are, and where a drop
 * says what to plan — but everything from "here is a plan" onwards lives here:
 * the question about conflicts, the run, the progress strip starting afresh,
 * and what the last transfer came to.
 */
export function useTransfers({
  connectionId,
  onFinished
}: {
  connectionId?: string
  /** After every run, whether or not it succeeded; the listing may have changed. */
  onFinished: (plan: TransferPlan) => void
}): {
  pending: PendingTransfer | null
  transferring: boolean
  setTransferring: (busy: boolean) => void
  /** Changes after each run, so the progress strip starts again from nothing. */
  progressKey: number
  /**
   * What went wrong with the last transfer, kept apart from the listing's own
   * error. The two shared one message, and refreshing the directory after a
   * failed upload — which is what happens after every upload — cleared the
   * failure the moment it was shown: a listing that loaded said nothing about
   * whether the copy had worked, and read as if it had.
   */
  outcome: string | null
  dismissOutcome: () => void
  /** Clears what the last batch came to, as a new one begins. */
  startBatch: () => void
  /**
   * Runs a plan once the ones before it are done, asking first about anything
   * it would overwrite. Resolves when it has run, or been cancelled or dropped
   * — so a loop over several plans runs each in turn. `madeOn` is the
   * connection the plan was made on; a plan whose turn comes after the panel
   * moved to another connection is dropped.
   */
  run: (plan: TransferPlan, source?: string, madeOn?: string) => Promise<void>
  confirm: (decisions: TransferDecisions) => Promise<void>
  cancel: () => void
} {
  const t = useT()
  const [pending, setPending] = useState<PendingTransfer | null>(null)
  const [transferring, setTransferring] = useState(false)
  const [progressKey, setProgressKey] = useState(0)
  const [outcome, setOutcome] = useState<string | null>(null)
  /*
   * Read when a plan's turn comes, not when it was queued: the panel may have
   * moved to another connection in between, and the closure would not know.
   */
  const connectionRef = useRef(connectionId)
  connectionRef.current = connectionId
  /** Ends the wait of the plan the conflict dialog is asking about. */
  const settleRef = useRef<(() => void) | null>(null)
  /** Plans run one after another, in the order they were asked for. */
  const queueRef = useRef<Promise<void>>(Promise.resolve())

  function settle(): void {
    const done = settleRef.current
    settleRef.current = null
    done?.()
  }

  /*
   * A plan belongs to the connection it was made on. The panel can be pointed
   * at another one — a reconnect, another tab — while the conflict dialog is
   * still open, and answering it then ran the old plan's paths against the new
   * connection. The question goes, and so does the last transfer's message.
   */
  useEffect(() => {
    setPending(null)
    setOutcome(null)
    settle()
  }, [connectionId])

  /*
   * Added to, not replaced. A batch is one plan per dropped item, run in turn,
   * and each used to clear the message as it started — so the first file's
   * failure was gone by the time the second had begun, and a batch whose last
   * item went through read as if all of it had. A new batch starts clean; see
   * `startBatch`.
   */
  function report(message: string): void {
    setOutcome((previous) =>
      previous
        ? `${previous}
${message}`
        : message
    )
  }

  /**
   * `source` is the host a relayed batch comes from. It leads the call because
   * `runPlan` reads from the first connection and writes to the second, and for
   * a relay this panel is the writing end.
   */
  async function execute(
    plan: TransferPlan,
    decisions: TransferDecisions,
    source?: string
  ): Promise<void> {
    const connectionId = connectionRef.current
    if (!connectionId) return
    setPending(null)
    try {
      const result = await window.td.sftp.runPlan(
        source ?? connectionId,
        plan,
        decisions,
        source ? connectionId : undefined
      )
      // Something arrived at these after the check and before their turn, and
      // was not overwritten. Said, because a file that was not copied is a file
      // somebody will go looking for.
      if (result?.changed?.length) {
        report(
          t('Left alone, because something appeared there after the check: {paths}', {
            paths: result.changed.join(', ')
          })
        )
      }
    } catch (err) {
      report((err as Error).message)
    }
    setTransferring(false)
    setProgressKey((key) => key + 1)
    onFinished(plan)
  }

  /**
   * Asks about anything the plan would trample, then runs it. Every batch asks
   * afresh — no answer is remembered between transfers, so a decision made once
   * in a hurry never governs a later copy.
   */
  function run(plan: TransferPlan, source?: string, madeOn?: string): Promise<void> {
    const turn = queueRef.current.then(() => runOne(plan, source, madeOn))
    queueRef.current = turn.catch(() => undefined)
    return turn
  }

  /*
   * This used to return as soon as the conflict dialog opened. A batch looping
   * over its items then went straight on to the next, whose plan replaced the
   * one being asked about: of two files with conflicts only the second was ever
   * copied, and the first was skipped without a word.
   */
  async function runOne(plan: TransferPlan, source?: string, madeOn?: string): Promise<void> {
    const connectionId = connectionRef.current
    if (plan.items.length === 0 || !connectionId) return
    if (madeOn && madeOn !== connectionId) return
    if (plan.conflicts.length === 0 && plan.collisions.length === 0) {
      await execute(plan, {}, source)
      return
    }
    await new Promise<void>((resolve) => {
      settleRef.current = resolve
      setPending({ plan, source, connectionId })
    })
  }

  async function confirm(decisions: TransferDecisions): Promise<void> {
    if (!pending) return
    try {
      if (pending.connectionId !== connectionRef.current) {
        setPending(null)
        return
      }
      await execute(pending.plan, decisions, pending.source)
    } finally {
      settle()
    }
  }

  return {
    pending,
    transferring,
    setTransferring,
    progressKey,
    outcome,
    dismissOutcome: () => setOutcome(null),
    startBatch: () => setOutcome(null),
    run,
    confirm,
    cancel: () => {
      setPending(null)
      settle()
    }
  }
}
