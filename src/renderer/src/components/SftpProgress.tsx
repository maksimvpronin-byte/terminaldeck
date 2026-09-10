import { useEffect, useState } from 'react'
import { formatSize } from '../../../shared/fileSize'

interface Transfer {
  path: string
  transferred: number
  total: number
}

/** Progress owns its renders so a fast transfer does not rebuild the file list. */
export default function SftpProgress({
  connectionId,
  onBusy
}: {
  connectionId?: string
  onBusy: (busy: boolean) => void
}): JSX.Element | null {
  const [transfer, setTransfer] = useState<Transfer | null>(null)
  useEffect(() => {
    if (!connectionId) return
    return window.td.sftp.onProgress(connectionId, (p) => {
      const busy = p.transferred < p.total
      setTransfer(busy ? p : null)
      onBusy(busy)
    })
  }, [connectionId, onBusy])
  if (!transfer) return null
  return (
    <div className="sftp-progress">
      <div className="sftp-progress-label">
        {transfer.path.split('/').pop()} — {formatSize(transfer.transferred)} /{' '}
        {formatSize(transfer.total)}
      </div>
      <div className="sftp-progress-track">
        <div
          className="sftp-progress-bar"
          style={{
            width: `${transfer.total > 0 ? (transfer.transferred / transfer.total) * 100 : 0}%`
          }}
        />
      </div>
    </div>
  )
}
