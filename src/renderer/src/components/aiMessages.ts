import type { Translate } from '../i18n'

/** Main returns stable messages; unknown transport errors remain available verbatim. */
export function aiMessage(value: string, t: Translate): string {
  switch (value) {
    case 'awaiting':
      return t('Awaiting command approval')
    case 'queued':
      return t('Planned')
    case 'pending':
      return t('Awaiting command approval')
    case 'running':
      return t('Running command')
    case 'thinking':
      return t('AI is interpreting results')
    case 'complete':
      return t('Analysis complete')
    case 'completed':
      return t('Completed')
    case 'stopped':
      return t('Analysis stopped')
    case 'cancelled':
      return t('Cancelled')
    case 'skipped':
      return t('Skipped')
    case 'error':
      return t('Error')
    case 'timeout':
      return t('Timed out')
    case 'truncated':
      return t('Output limit reached')
    case 'critical':
      return t('Critical')
    case 'warning':
      return t('Warning')
    case 'info':
      return t('Information')
    case 'AI settings saved':
      return t('AI settings saved')
    case 'AI settings removed':
      return t('AI settings removed')
    case 'AI connection works':
      return t('AI connection works')
    case 'Could not load AI settings':
      return t('Could not load AI settings')
    case 'SSH connection is unavailable':
      return t('SSH connection is unavailable')
    case 'Configure AI and allow diagnostic data transfer first':
      return t('Configure AI and allow diagnostic data transfer first')
    case 'Configure API key and model first':
      return t('Configure API key and model first')
    case 'Enter a new API key when changing endpoint':
      return t('Enter a new API key when changing endpoint')
    case 'Invalid AI settings':
      return t('Invalid AI settings')
    case 'Invalid API key':
      return t('Invalid API key')
    case 'Use HTTPS (HTTP is allowed only on loopback)':
      return t('Use HTTPS (HTTP is allowed only on loopback)')
    case 'AI request failed or returned an invalid proposal/report. Check settings; no additional command was executed.':
      return t(
        'AI request failed or returned an invalid proposal/report. Check settings; no additional command was executed.'
      )
    case 'Analysis failed; inspect the connection or AI settings. Collected results are retained.':
      return t(
        'Analysis failed; inspect the connection or AI settings. Collected results are retained.'
      )
    case 'Could not generate the report':
      return t('Could not generate the report')
    case 'Diagnostic budget exhausted':
      return t('Diagnostic budget exhausted')
    case 'Analysis budget exhausted; collected results are retained':
      return t('Analysis budget exhausted; collected results are retained')
    case 'AI context budget exhausted; collected results are retained':
      return t('AI context budget exhausted; collected results are retained')
    default: {
      // Electron prefixes invoke errors with its channel; translate only the message.
      const prefix = /^Error invoking remote method '[^']+': Error: (.*)$/s.exec(value)
      return prefix ? aiMessage(prefix[1], t) : value
    }
  }
}
