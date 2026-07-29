# Agent Flow Architecture

Agent Flow is a real-time visualization tool for agentic coding workflows. It provides an interactive UI to monitor the execution of various AI coding agents.

## Core Components

The project is split into two main layers:
1. **Backend Relay & Watchers (Node.js)**: Responsible for observing agent activity, parsing proprietary log formats, and broadcasting standardized events.
2. **Frontend UI (Next.js & React)**: Responsible for maintaining simulation state, buffering events, and rendering the interactive graph and timeline.

## Supported Agent Runtimes

Agent Flow currently supports three agent runtimes, each integrated via its own session watcher:

- **Claude Code**: Integrated via HTTP hooks.
- **Codex**: Integrated via file tailing of `~/.codex/sessions/**/rollout-*.jsonl`.
- **Antigravity**: Integrated via file tailing of `~/.gemini/antigravity-cli/brain/**/transcript.jsonl`.

## Event Streaming Data Flow

1. **Log Generation**: The agent runtime (Codex, Antigravity) writes execution steps to a `.jsonl` file.
2. **Session Watchers**: 
   - Watchers (e.g., `AntigravitySessionWatcher`, `CodexSessionWatcher`) use `fs.watch` with a fallback `setInterval` polling mechanism to detect file changes.
   - They use `readNewFileLines` to efficiently tail only the newly appended lines.
3. **Parsers**:
   - The raw JSONL strings are fed into parsers (e.g., `AntigravityParser`).
   - Parsers convert proprietary schema into standard `AgentEvent` protocol formats (e.g., `agent_spawn`, `tool_call_start`, `message`).
4. **Event Relay (`scripts/relay.ts`)**:
   - Events are buffered in memory (`eventBuffer`).
   - The relay server exposes an SSE (Server-Sent Events) endpoint at `/events`.
   - When a client connects, the relay replays the buffered events for all active sessions to ensure the frontend is synchronized.
5. **Frontend Bridge (`use-vscode-bridge.ts`)**:
   - The web app connects to the SSE endpoint and receives the event stream.
   - Events are continuously pushed into a background buffer (`sessionEventsRef`) categorized by `sessionId`.
6. **Simulation State (`use-agent-simulation.ts`)**:
   - When a session is selected (tab switch), the UI restores the most recent `snapshot` of that session.
   - It then flushes the unseen events from `sessionEventsRef` into the simulation engine.
   - The engine processes the events using `requestAnimationFrame`, updating a `frameRef` to achieve a smooth 60fps render without overwhelming React's virtual DOM.

## Managing Real-time State & Multi-session

To support tracking multiple concurrent agent sessions without losing data:
- **Relay Broadcasting**: The backend sends `agent-event-batch` for **all** active sessions upon any new connection (e.g., page refresh).
- **Frontend Buffering**: The frontend indiscriminately buffers all incoming SSE events into `sessionEventsRef`, even for tabs that are not currently focused.
- **State Snapshotting**: When switching tabs, the outgoing session's state is snapshotted (`sessionCacheRef`) along with its event count. When returning to the tab, the state is restored, and only the *delta* of new events is processed, keeping the visualization perfectly in sync.
