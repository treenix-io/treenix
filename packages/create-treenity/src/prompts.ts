import { cancel, confirm, isCancel, text } from '@clack/prompts';

export type Choices = {
  projectName: string
  frontend: boolean
  exampleMod: boolean
}

export function parseArgs(argv: string[]): { name?: string; yes: boolean } {
  const args = argv.slice(2)
  return {
    name: args.find(a => !a.startsWith('-')),
    yes: args.includes('-y') || args.includes('--yes'),
  }
}

export async function promptUser(nameArg?: string, yes = false): Promise<Choices> {
  // Non-interactive mode: use defaults
  if (yes) {
    return {
      projectName: nameArg ?? 'my-treenity-app',
      frontend: true,
      exampleMod: true,
    }
  }

  const projectName = nameArg ?? await text({
    message: 'Project name',
    placeholder: 'my-treenity-app',
    validate: v => v.length === 0 ? 'Required' : undefined,
  })
  if (isCancel(projectName)) { cancel(); process.exit(0) }

  const frontend = await confirm({ message: 'Include frontend (React + Vite + Tailwind)?' })
  if (isCancel(frontend)) { cancel(); process.exit(0) }

  const exampleMod = await confirm({ message: 'Add example mod?' })
  if (isCancel(exampleMod)) { cancel(); process.exit(0) }

  return {
    projectName: String(projectName),
    frontend: Boolean(frontend),
    exampleMod: Boolean(exampleMod),
  }
}
