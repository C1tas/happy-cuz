import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { runCodex } from '@/codex/runCodex'
import { extractCodexResumeFlag } from '@/codex/cliArgs'
import { extractNoSandboxFlag } from '@/utils/sandboxFlags'
import { ensureDaemonRunning } from '@/daemon/ensureDaemonRunning'

export async function handleCodexCommand(args: string[]): Promise<void> {
  let startedBy: 'daemon' | 'terminal' | undefined = undefined
  let happySessionId: string | undefined = undefined
  const sandboxArgs = extractNoSandboxFlag(args)
  const codexArgs = extractCodexResumeFlag(sandboxArgs.args)

  for (let i = 0; i < codexArgs.args.length; i++) {
    if (codexArgs.args[i] === '--started-by') {
      startedBy = codexArgs.args[++i] as 'daemon' | 'terminal'
    } else if (codexArgs.args[i] === '--happy-session-id') {
      happySessionId = codexArgs.args[++i]
    }
  }

  const { credentials } = await authAndSetupMachineIfNeeded()
  await ensureDaemonRunning()

  await runCodex({
    credentials,
    startedBy,
    noSandbox: sandboxArgs.noSandbox,
    resumeThreadId: codexArgs.resumeThreadId ?? undefined,
    happySessionId,
  })
}
