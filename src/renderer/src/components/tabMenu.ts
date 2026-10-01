import { useStore } from '../state/store'
import { allTabs } from '../state/workspaces'
import type { MenuItem } from './ContextMenu'
import type { Translate } from '../i18n'

/**
 * What a tab adds to its host's menu when that menu is asked for from the tab:
 * the things that are about the tab rather than the host.
 */
export function tabMenuItems(t: Translate, tabId: string | undefined): MenuItem[] {
  if (!tabId) return []
  const tab = allTabs(useStore.getState()).find((x) => x.id === tabId)
  if (!tab) return []
  return [
    {
      label: t('Save tab as multi-window…'),
      separated: true,
      onSelect: () => useStore.getState().draftMultiWindow({ tabId, name: tab.title })
    }
  ]
}
