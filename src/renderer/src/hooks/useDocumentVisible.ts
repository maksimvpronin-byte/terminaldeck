import { useEffect, useState } from 'react'

export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(!document.hidden)
  useEffect(() => {
    const changed = (): void => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', changed)
    return () => document.removeEventListener('visibilitychange', changed)
  }, [])
  return visible
}
