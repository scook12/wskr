import { resolve } from "node:path"

export function isAllowedWorkdir(workdir: string, allowedRoots: string[]): boolean {
  const normalizedWorkdir = resolve(workdir)
  return allowedRoots.some((allowedRoot) => {
    const normalizedRoot = resolve(allowedRoot)
    return (
      normalizedWorkdir === normalizedRoot || normalizedWorkdir.startsWith(`${normalizedRoot}/`)
    )
  })
}
