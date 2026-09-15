import { useState } from 'react'
import type { TransferDecisions, TransferPlan } from '../../../shared/types'
import { useT } from '../i18n'

/** A planned transfer waiting on an answer about what it would overwrite. */
export interface PendingTransfer {
  plan: TransferPlan
  /** The host the files come from, when they come from another one. */
  source?: string
}

/**
 * Running a planned transfer, for a file panel that is the writing end of it.
 *
 * Planning stays with the panel — it is where the dialogs are, and where a drop
 * says what to plan — but everything from "here is a plan" onwards was woven
 * through the same component as rows, columns, renaming and drag and drop: the
 * question about conflicts, the run, the progress strip starting afresh, and
 * what went wrong. This is that part on its own.
 */
export function useTransfers({
  connectionId,
  onError,
  onFinished
}: {
  connectionId?: string
  onError: (message: string | null) => void
  /** After every run, whether or not it succeeded; the listing may have changed. */
  onFinished: (plan: TransferPlan) => void
}): {
  pending: PendingTransfer | null
  transferring: boolean
  setTransferring: (busy: boolean) => void
  /** Changes after each run, so the progress strip starts again from nothing. */
  progressKey: number
  run: (plan: TransferPlan, source?: string) => Promise<void>
  confirm: (decisions: TransferDecisions) => Promise<void>
  cancel: () => void
} {
  const t = useT()
  const [pending, setPending] = useState<PendingTransfer | null>(null)
  const [transferring, setTransferring] = useState(false)
  const [progressKey, setProgressKey] = useState(0)

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
    onError(null)
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
        onError(
          t('Left alone, because something appeared there after the check: {paths}', {
            paths: result.changed.join(', ')
          })
        )
      }
    } catch (err) {
      onError((err as Error).message)
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
    if (plan.items.length === 0) return
    if (plan.conflicts.length === 0 && plan.collisions.length === 0) {
      await execute(plan, {}, source)
      return
    }
    setPending({ plan, source })
  }

  async function confirm(decisions: TransferDecisions): Promise<void> {
    if (pending) await execute(pending.plan, decisions, pending.source)
  }

  return {
    pending,
    transferring,
    setTransferring,
    progressKey,
    run,
    confirm,
    cancel: () => setPending(null)
  }
}
