import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { AgentEvent, SessionInfo } from './protocol'
import {
  ACTIVE_SESSION_AGE_S, INACTIVITY_TIMEOUT_MS, ORCHESTRATOR_NAME,
  POLL_FALLBACK_MS, SCAN_INTERVAL_MS, SESSION_ID_DISPLAY,
} from './constants'
import { readNewFileLines } from './fs-utils'
import { createLogger } from './logger'
import { AntigravityParser } from './antigravity-parser'
import type { AgentSessionWatcher, SessionLifecycleEvent } from './session-runtime'
import { TypedEventEmitter } from './typed-event-emitter'

const log = createLogger('AntigravitySessionWatcher')

interface WatchedAntigravitySession {
  sessionId: string
  filePath: string
  fileWatcher: fs.FSWatcher | null
  pollTimer: NodeJS.Timeout | null
  inactivityTimer: NodeJS.Timeout | null
  fileSize: number
  fileTail: string
  sessionStartTime: number
  lastActivityTime: number
  sessionDetected: boolean
  sessionCompleted: boolean
  label: string
  parser: AntigravityParser
}

function antigravityHome(): string {
  return path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain')
}

export class AntigravitySessionWatcher implements AgentSessionWatcher {
  private dirWatchers = new Map<string, fs.FSWatcher>()
  private sessions = new Map<string, WatchedAntigravitySession>()
  private scanInterval: NodeJS.Timeout | null = null

  private readonly _onEvent = new TypedEventEmitter<AgentEvent>()
  private readonly _onSessionDetected = new TypedEventEmitter<string>()
  private readonly _onSessionLifecycle = new TypedEventEmitter<SessionLifecycleEvent>()

  readonly onEvent = this._onEvent.event
  readonly onSessionDetected = this._onSessionDetected.event
  readonly onSessionLifecycle = this._onSessionLifecycle.event

  constructor() {}

  isActive(): boolean {
    for (const s of this.sessions.values()) {
      if (s.sessionDetected && !s.sessionCompleted) return true
    }
    return false
  }

  isSessionActive(sessionId: string): boolean {
    const s = this.sessions.get(sessionId)
    return !!s && s.sessionDetected && !s.sessionCompleted
  }

  getActiveSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).map(s => ({
      id: s.sessionId,
      label: s.label,
      status: s.sessionCompleted ? 'completed' : 'active',
      startTime: s.sessionStartTime,
      lastActivityTime: s.lastActivityTime,
    }))
  }

  replaySessionStart(sessionIds?: string[]): void {
    for (const [id, session] of this.sessions) {
      if (!session.sessionDetected) continue
      if (sessionIds && !sessionIds.includes(id)) continue
      this._onSessionLifecycle.fire({ type: 'started', sessionId: id, label: session.label })
    }
  }

  start(): void {
    this.scanForSessions()
    this.scanInterval = setInterval(() => this.scanForSessions(), SCAN_INTERVAL_MS)

    const root = antigravityHome()
    if (fs.existsSync(root)) {
      try {
        const rootWatcher = fs.watch(root, { recursive: false }, () => this.scanForSessions())
        this.dirWatchers.set(root, rootWatcher)
      } catch (err) { log.debug('Root dir watch failed:', err) }
    }

    log.info(`Watching ${root} for Antigravity sessions`)
  }

  private scanForSessions(): void {
    const root = antigravityHome()
    if (!fs.existsSync(root)) return

    let entries: string[]
    try { entries = fs.readdirSync(root) }
    catch { return }

    for (const sessionId of entries) {
      const dir = path.join(root, sessionId, '.system_generated', 'logs')
      if (!fs.existsSync(dir)) continue
      
      const filePath = path.join(dir, 'transcript.jsonl')
      if (!fs.existsSync(filePath)) continue

      if (this.sessions.has(sessionId)) continue

      let stat: fs.Stats
      try { stat = fs.statSync(filePath) } catch { continue }
      if (stat.size === 0) continue
      const ageS = (Date.now() - stat.mtimeMs) / 1000
      if (ageS > ACTIVE_SESSION_AGE_S) continue

      this.attachSession(filePath, sessionId, stat)
    }
  }

  private attachSession(filePath: string, sessionId: string, stat: fs.Stats): void {
    const label = `Antigravity ${sessionId.slice(0, SESSION_ID_DISPLAY)}`

    const parser = new AntigravityParser({
      emit: (event) => this._onEvent.fire({ ...event, sessionId }),
      elapsed: () => {
        const s = this.sessions.get(sessionId)
        return s ? (Date.now() - s.sessionStartTime) / 1000 : 0
      },
      setLabel: (newLabel) => {
        const s = this.sessions.get(sessionId)
        if (!s || !s.label.startsWith('Antigravity ')) return
        s.label = newLabel
        this._onSessionLifecycle.fire({ type: 'updated', sessionId, label: newLabel })
      },
    })

    const session: WatchedAntigravitySession = {
      sessionId,
      filePath,
      fileWatcher: null,
      pollTimer: null,
      inactivityTimer: null,
      fileSize: 0,
      fileTail: '',
      sessionStartTime: stat.birthtimeMs || stat.mtimeMs,
      lastActivityTime: stat.mtimeMs,
      sessionDetected: false,
      sessionCompleted: false,
      label,
      parser,
    }
    this.sessions.set(sessionId, session)

    this.readNewLines(sessionId)

    session.sessionDetected = true
    this._onSessionDetected.fire(sessionId)
    this._onSessionLifecycle.fire({ type: 'started', sessionId, label })

    try {
      session.fileWatcher = fs.watch(filePath, () => this.readNewLines(sessionId))
    } catch (err) { log.debug('File watch failed:', filePath, err) }

    session.pollTimer = setInterval(() => this.readNewLines(sessionId), POLL_FALLBACK_MS)

    this.resetInactivityTimer(sessionId)
    log.info(`Attached to Antigravity session ${sessionId.slice(0, SESSION_ID_DISPLAY)} at ${filePath}`)
  }

  private readNewLines(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    const result = readNewFileLines(session.filePath, session.fileSize, session.fileTail)
    if (!result) return
    session.fileSize = result.newSize
    session.fileTail = result.tail
    session.lastActivityTime = Date.now()

    if (session.sessionCompleted) {
      session.sessionCompleted = false
      this._onSessionLifecycle.fire({ type: 'started', sessionId, label: session.label })
      log.info(`Antigravity Session ${sessionId.slice(0, SESSION_ID_DISPLAY)} re-activated after idle`)
    }

    for (const line of result.lines) {
      try { session.parser.processLine(line) }
      catch (err) { log.debug('Parser threw on line:', err) }
    }

    this.resetInactivityTimer(sessionId)
  }

  private resetInactivityTimer(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    if (session.inactivityTimer) { clearTimeout(session.inactivityTimer) }
    session.inactivityTimer = setTimeout(() => {
      if (session.sessionCompleted) return
      session.sessionCompleted = true
      this._onEvent.fire({
        time: (Date.now() - session.sessionStartTime) / 1000,
        type: 'agent_complete',
        payload: { name: ORCHESTRATOR_NAME, sessionEnd: true },
        sessionId,
      })
      this._onSessionLifecycle.fire({ type: 'ended', sessionId, label: session.label })
    }, INACTIVITY_TIMEOUT_MS)
  }

  dispose(): void {
    if (this.scanInterval) { clearInterval(this.scanInterval) }
    for (const w of this.dirWatchers.values()) w.close()
    this.dirWatchers.clear()
    for (const s of this.sessions.values()) {
      s.fileWatcher?.close()
      if (s.pollTimer) clearInterval(s.pollTimer)
      if (s.inactivityTimer) clearTimeout(s.inactivityTimer)
    }
    this.sessions.clear()
    this._onEvent.dispose()
    this._onSessionDetected.dispose()
    this._onSessionLifecycle.dispose()
  }
}
