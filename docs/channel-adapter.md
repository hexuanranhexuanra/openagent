# Channel Adapter

The Channel Adapter connects external IM platforms (Feishu, Telegram, …) to the agent
runtime. It follows a **Producer-Consumer** pattern with a dual in-memory queue as the
data bus, fully decoupling message ingestion from agent execution and delivery.

## Architecture

```
User (Feishu / Telegram / Mock)
        │
        ▼
┌─────────────────────────────────────────────────┐
│  External Channels  (src/channels/)             │
│                                                 │
│  FeishuChannel   TelegramChannel   MockChannel  │
│       │               │                │        │
│       └───────────────┴────────────────┘        │
│                       │ publish_inbound          │
│                       ▼                         │
│         ┌─────────────────────────┐             │
│         │      MessageQueue       │             │
│         │  ┌──────────────────┐  │             │
│         │  │  Inbound Queue   │  │             │
│         │  └────────┬─────────┘  │             │
│         │           │             │             │
│         │  ┌────────▼─────────┐  │             │
│         │  │  Outbound Queue  │  │             │
│         │  └────────┬─────────┘  │             │
│         └───────────┼────────────┘             │
│                     │                           │
│          ┌──────────┴──────────┐                │
│          │                     │                │
│          ▼                     ▼                │
│   AgentBridge            ChannelManager         │
│  (per-session loop)     (outbound dispatch)     │
│          │                     │                │
│          │  runAgent()         │ channel.send() │
│          ▼                     ▼                │
│      Agent Runtime       FeishuChannel.send()   │
└─────────────────────────────────────────────────┘
```

> **Note on naming:** The component is called `GatewayAdapter` in the reference design doc
> (where the Channel Adaptor is a separate daemon connecting to an external Agent Gateway).
> In this single-process implementation it lives in `src/channels/gateway-adapter.ts` and
> calls `runAgent()` directly. A future rename to `AgentBridge` is planned.

## Components

### MessageQueue (`src/channels/message-queue.ts`)

The data hub. Two in-memory async queues:

| Queue    | Producer              | Consumer         |
|----------|-----------------------|------------------|
| inbound  | Channel (onMessage)   | GatewayAdapter   |
| outbound | GatewayAdapter        | ChannelManager   |

`consume*()` is waiter-based (not polling): callers `await` a Promise that resolves
the moment a message is published. `stop()` unblocks all pending waiters so loops
exit cleanly.

### GatewayAdapter (`src/channels/gateway-adapter.ts`)

Bridges the inbound queue to the agent runtime.

**Session loop model** — for each `channelType:peerId` key, one session runs at a time:

- If no session is active → spawn immediately
- If a session is already running → buffer the new message; drain after current finishes
- This guarantees: users never block each other, and messages from the same user are
  processed sequentially (no interleaving within a conversation)

**Per-session lifecycle:**

```
consumeInbound()
  → sessionKey = channelType:peerId
  → spawnSession(key, msg)
      → runAgent(channelType, peerId, content)   // streams
      → collect full response
      → publishOutbound({ replyToId: msg.raw.messageId })
  → on finish: drain next buffered message for this key
```

`stop()` issues `AbortController.abort()` on all active sessions and clears all buffers.

### ChannelManager (`src/channels/manager.ts`)

Lifecycle manager + outbound router.

- `register(channel)` — attaches `onMessage` handler; all inbound events funnel through
  `ChannelManager.messageHandler` which publishes to the inbound queue
- `startAll() / stopAll()` — lifecycle for all registered channels
- `startOutboundDispatch(queue)` — starts a background loop that reads from the outbound
  queue and calls `channel.send(msg)` on the matching channel by `channelType`

### Channels (`src/channels/`)

Each channel implements the `Channel` interface (`base.ts`):

```ts
interface Channel {
  readonly type: string
  start(): Promise<void>
  stop(): Promise<void>
  send(message: OutgoingMessage): Promise<void>
  onMessage(handler: (message: IncomingMessage) => Promise<void>): void
}
```

| Channel        | File             | Notes                                              |
|----------------|------------------|----------------------------------------------------|
| `FeishuChannel`| `feishu-ws.ts`   | Lark SDK WebSocket; no public URL needed           |
| `WebChatChannel`| `webchat.ts`    | Browser WS; bypasses queue (streams directly)      |
| `MockChannel`  | `mock.ts`        | In-memory; for local testing without a real IM     |

> Webchat uses the gateway WebSocket for real-time streaming and intentionally bypasses
> the queue. Queue-based channels (Feishu, Telegram) collect the full response then deliver.

### Protocol / Types (`src/types/index.ts`)

```ts
// Inbound: external channel → agent
InboundMessage = { channelType, channelId, peerId, content, timestamp, raw? }

// Outbound: agent → external channel
OutboundMessage = { channelType, channelId, peerId, content, replyToId? }
```

`raw` carries channel-specific metadata (e.g. Feishu `messageId` for threaded replies).
`GatewayAdapter` reads `raw.messageId` and sets it as `replyToId` on the outbound message.
`FeishuChannel.send()` then uses `replyToId` to call `larkClient.im.message.reply()`.

## Data Flow

### Upward (user → agent)

```
1. User sends "Hello" in Feishu
2. FeishuChannel.handleIncoming() → builds InboundMessage { raw: { messageId } }
3. ChannelManager.messageHandler() → mq.publishInbound(msg)
4. GatewayAdapter loop wakes → sessionKey = "feishu:ou_abc123"
5. spawnSession() → runAgent("feishu", "ou_abc123", "Hello")
```

### Downward (agent → user)

```
6. Agent streams text chunks, GatewayAdapter accumulates fullResponse
7. mq.publishOutbound({ channelType:"feishu", replyToId:"msg_xyz", content: fullResponse })
8. ChannelManager outbound loop wakes → channel = channels.get("feishu")
9. feishuChannel.send(msg) → larkClient.im.message.reply({ message_id: "msg_xyz", ... })
10. User sees reply as a thread under their original message
```

## Startup Wiring (`src/cli/index.ts`)

```ts
const mq = getMessageQueue()
const adapter = getGatewayAdapter()
const manager = new ChannelManager()

// All inbound → queue
manager.onMessage(async (msg) => mq.publishInbound(msg))

// Register channels
manager.register(new FeishuChannel({ appId, appSecret }))

await manager.startAll()
manager.startOutboundDispatch(mq)   // background outbound loop
adapter.start(mq)                   // background inbound loop (no await)
```

## Extending: Adding a New Channel

1. Create `src/channels/telegram.ts` implementing `Channel`
2. `send()` calls the Telegram Bot API
3. `start()` connects (polling or webhook)
4. `handleIncoming()` calls `this.handler(inboundMsg)`
5. Register in `cli/index.ts`:
   ```ts
   manager.register(new TelegramChannel({ botToken }))
   ```

No changes to `GatewayAdapter`, `MessageQueue`, or `ChannelManager` needed.
