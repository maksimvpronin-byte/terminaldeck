import { useEffect, useState } from 'react'
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
  run: (plan: TransferPlan, source?: string) => Promise<void>
  confirm: (decisions: TransferDecisions) => Promise<void>
  cancel: () => void
} {
  const t = useT()
  const [pending, setPending] = useState<PendingTransfer | null>(null)
  const [transferring, setTransferring] = useState(false)
  const [progressKey, setProgressKey] = useState(0)
  const [outcome, setOutcome] = useState<string | null>(null)

  /*
   * A plan belongs to the connection it was made on. The panel can be pointed
   * at another one — a reconnect, another tab — while the conflict dialog is
   * still open, and answering it then ran the old plan's paths against the new
   * connection. The question goes, and so does the last transfer's message.
   */
  useEffect(() => {
    setPending(null)
    setOutcome(null)
  }, [connectionId])

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
    if (!connectionId) return
    setPending(null)
    setOutcome(null)
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
        setOutcome(
          t('Left alone, because something appeared there after the check: {paths}', {
            paths: result.changed.join(', ')
          })
        )
      }
    } catch (err) {
      setOutcome((err as Error).message)
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
  async function run(plan: TransferPlan, source?: string): Promise<void> {
    if (plan.items.length === 0 || !connectionId) return
    if (plan.conflicts.length === 0 && plan.collisions.length === 0) {
      await execute(plan, {}, source)
      return
    }
    setPending({ plan, source, connectionId })
  }

  async function confirm(decisions: TransferDecisions): Promise<void> {
    if (!pending) return
    if (pending.connectionId !== connectionId) {
      setPending(null)
      return
    }
    await execute(pending.plan, decisions, pending.source)
  }

  return {
    pending,
    transferring,
    setTransferring,
    progressKey,
    outcome,
    dismissOutcome: () => setOutcome(null),
    run,
    confirm,
    cancel: () => setPending(null)
  }
}
