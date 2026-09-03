/**
 * Types for the build hook beside this file, which is plain CommonJS because
 * electron-builder loads it by path and runs it as it finds it. The test that
 * imports it is TypeScript, and this is what lets it be read rather than
 * silently treated as `any`.
 */

export interface PackContext {
  electronPlatformName: string
  appOutDir: string
  packager: { appInfo: { productFilename: string } }
}

export interface SigningPlan {
  command: string
  args: string[]
  app: string
}

export function signingPlan(
  context: PackContext,
  env: Record<string, string | undefined>
): SigningPlan | null

declare const adhocSign: (context: PackContext) => Promise<void>
export default adhocSign
