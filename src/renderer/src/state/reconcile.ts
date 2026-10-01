/** A multi-file mutation may persist its first step before a later step fails. */
export async function rereadOnFailure<T>(
  change: () => Promise<T>,
  reread: () => Promise<unknown>
): Promise<T> {
  try {
    return await change()
  } catch (err) {
    await reread().catch(() => undefined)
    throw err
  }
}
