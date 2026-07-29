import { AntigravitySessionWatcher } from './extension/src/antigravity-session-watcher'

const watcher = new AntigravitySessionWatcher()
watcher.onSessionLifecycle(e => console.log('Lifecycle:', e))
watcher.onSessionDetected(e => console.log('Detected:', e))
watcher.onEvent(e => console.log('Event:', e))
watcher.start()

setTimeout(() => {
  console.log('Active sessions:', watcher.getActiveSessions())
  process.exit(0)
}, 2000)
