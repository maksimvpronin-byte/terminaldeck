/**
 * Phrases that reach the interface as data, not as source.
 *
 * A failed file copy is explained by whichever part noticed: the RDP client,
 * which is C and speaks over a pipe, or the transfer in the main process. Both
 * hand up a finished English sentence, and the screen shows it through `t()`
 * like everything else — but the key is a value at that point, so the phrase
 * book's coverage test cannot see it written anywhere in the renderer.
 *
 * Listing them here is what makes them visible to it. The same test then reads
 * the two files below and checks the list against what they actually say, so a
 * sentence reworded on one side of the pipe cannot quietly go untranslated on
 * the other.
 */
export const EXTERNAL_PHRASE_SOURCES = [
  'resources/freerdp/shim/td_rdp.c',
  'src/main/rdp/ClipboardDownload.ts'
]

export const EXTERNAL_PHRASES = [
  'Nothing is copied on this computer',
  'This build cannot read local files into the clipboard',
  'Windows would not accept the copied paths',
  'Cannot open the copied files on this computer',
  'This session cannot carry a file of 2 GB or more',
  'The server did not supply a file list',
  'Invalid RDP file list',
  'Unterminated RDP file name',
  'Unsafe RDP file name',
  'RDP links are not supported',
  'The server did not supply the file size',
  'Clipboard transfer exceeds 20 GB',
  'Duplicate RDP file name',
  'A file is used as a directory',
  'RDP file transfer timed out',
  'The RDP server refused or truncated the file transfer',
  'Could not write the received file'
]
