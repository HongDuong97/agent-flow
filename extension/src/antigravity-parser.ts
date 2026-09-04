import { AgentEvent } from './protocol'
import { ORCHESTRATOR_NAME } from './constants'

export interface AntigravityParserDelegate {
  emit: (event: AgentEvent) => void
  elapsed: () => number
  setLabel: (label: string) => void
}

export class AntigravityParser {
  private seenSteps = new Set<number>()
  private pendingTools: Array<{ name: string; args: string }> = []
  private spawned = false

  constructor(private delegate: AntigravityParserDelegate) {}

  processLine(line: string) {
    if (!line.trim()) return
    let parsed: any
    try {
      parsed = JSON.parse(line)
    } catch { return }

    if (parsed.step_index === undefined) return
    if (this.seenSteps.has(parsed.step_index)) return
    this.seenSteps.add(parsed.step_index)

    const time = this.delegate.elapsed()

    if (parsed.type === 'USER_INPUT' && parsed.content) {
      let label = 'Antigravity Session'
      if (parsed.step_index === 0) {
        const match = parsed.content.match(/<USER_REQUEST>\n([\s\S]*?)\n<\/USER_REQUEST>/)
        if (match && match[1]) {
          label = match[1].trim().split('\n')[0].slice(0, 50)
        }
        this.delegate.setLabel(label)
      }
      if (!this.spawned) {
        this.spawned = true
        this.delegate.emit({
          time: 0,
          type: 'agent_spawn',
          payload: { name: ORCHESTRATOR_NAME, isMain: true, task: label, runtime: 'antigravity' },
        })
      }
      this.delegate.emit({
        time,
        type: 'message',
        payload: { role: 'user', content: parsed.content },
      })
    } else if (parsed.type === 'PLANNER_RESPONSE') {
      if (parsed.content) {
        this.delegate.emit({
          time,
          type: 'message',
          payload: { role: 'assistant', content: parsed.content },
        })
      }
      if (parsed.tool_calls && Array.isArray(parsed.tool_calls)) {
        for (const tc of parsed.tool_calls) {
          const argsStr = JSON.stringify(tc.args)
          this.pendingTools.push({ name: tc.name, args: argsStr })
          this.delegate.emit({
            time,
            type: 'tool_call_start',
            payload: {
              agent: ORCHESTRATOR_NAME,
              tool: tc.name,
              args: argsStr,
              preview: `${tc.name}: ${argsStr}`.slice(0, 100),
            },
          })
        }
      }
    } else if (parsed.type && typeof parsed.type === 'string' && 
               !['USER_INPUT', 'PLANNER_RESPONSE', 'EPHEMERAL_MESSAGE', 'CONVERSATION_HISTORY', 'CHECKPOINT'].includes(parsed.type)) {
      // Treat as tool result
      let name = parsed.type
      // try to match with pending tools
      const pendingIdx = this.pendingTools.findIndex(t => t.name.toUpperCase() === parsed.type)
      if (pendingIdx >= 0) {
        name = this.pendingTools[pendingIdx].name
        this.pendingTools.splice(pendingIdx, 1)
      }
      
      const contentStr = typeof parsed.content === 'string' ? parsed.content : JSON.stringify(parsed.content || {})
      
      const isError = parsed.status === 'ERROR' || parsed.status === 'CANCELLED'

      this.delegate.emit({
        time,
        type: 'tool_call_end',
        payload: {
          agent: ORCHESTRATOR_NAME,
          tool: name,
          result: contentStr.slice(0, 500) + (contentStr.length > 500 ? '...' : ''),
          isError,
        },
      })
    }
  }
}
